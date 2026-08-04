import { useCallback, useEffect, useState } from "react";

import { ScripturePanel } from "./components/ScripturePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { StagePanel } from "./components/StagePanel";
import { TopBar } from "./components/TopBar";
import { TranscriptPanel } from "./components/TranscriptPanel";
import {
  describeError,
  getSettings,
  listAudioInputs,
  saveSettings,
  startTranscription,
  stopTranscription,
  type AudioDevice,
  type SettingsView,
} from "./lib/api";
import { libraryStatus, onLibraryStatus, type LibraryStatus } from "./lib/bible";
import {
  closeProjector,
  listDisplays,
  openProjector,
  projectorState,
  type Display,
  type ProjectorState,
} from "./lib/projector";
import { exportTranscript } from "./lib/exportTranscript";
import { DEFAULT_THEME } from "./lib/theme";
import { useDetections } from "./lib/useDetections";
import { usePresentation } from "./lib/usePresentation";
import { useSchedule } from "./lib/useSchedule";
import { useSemanticIndex } from "./lib/useSemanticIndex";
import { useSpokenReferences } from "./lib/useSpokenReferences";
import { useSuggestions } from "./lib/useSuggestions";
import { useTranscript } from "./lib/useTranscript";

export default function App() {
  const { lines, interim, status, clear } = useTranscript();
  const {
    preview,
    live,
    liveKey,
    history,
    previewVerse,
    previewVerses,
    previewItem,
    keyOf,
    display,
    clearLive,
    step,
    canStepBack,
    canStepForward,
  } = usePresentation();
  const { detections } = useDetections();
  const { suggestions } = useSuggestions();
  const { references } = useSpokenReferences();
  const semanticIndex = useSemanticIndex();

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [library, setLibrary] = useState<LibraryStatus>({
    ready: false,
    translations: [],
    importing: null,
    error: null,
  });
  const [translation, setTranslation] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<Display[]>([]);
  const [projector, setProjector] = useState<ProjectorState>({ open: false, display: null });

  // The running order. Kept in the library rather than in state, so closing
  // the app mid-service does not cost the plan.
  const schedule = useSchedule(setError);

  const stageEntry = useCallback(
    async (index: number) => {
      const staged = await schedule.stage(index);
      if (staged) previewItem(staged);
      return staged;
    },
    [schedule, previewItem],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([getSettings(), listAudioInputs()])
      .then(([loaded, inputs]) => {
        if (!active) return;
        setSettings(loaded);
        setDevices(inputs);
      })
      .catch((err) => active && setError(describeError(err)));
    return () => {
      active = false;
    };
  }, []);

  // The library import runs in the background on first launch, so take the
  // current state now and keep listening for it to finish.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    const apply = (next: LibraryStatus) => {
      if (!active) return;
      setLibrary(next);
    };

    void libraryStatus().then(apply).catch(() => undefined);
    void onLibraryStatus(apply).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Settings and the library arrive independently, so reconcile once both
  // are here. Defaulting to the first translation would quietly disagree with
  // the backend, which detects against whatever was saved.
  useEffect(() => {
    if (!settings || library.translations.length === 0) return;
    const available = (id: string) => library.translations.some((entry) => entry.id === id);
    setTranslation((current) => {
      if (current && available(current)) return current;
      if (settings.translation && available(settings.translation)) return settings.translation;
      return library.translations[0]?.id ?? "";
    });
  }, [settings, library.translations]);

  // Displays get plugged in after the app is already open, so refresh the
  // list whenever the operator goes looking rather than only at launch.
  const refreshDisplays = useCallback(async () => {
    try {
      const [found, state] = await Promise.all([listDisplays(), projectorState()]);
      setDisplays(found);
      setProjector(state);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refreshDisplays();
  }, [refreshDisplays]);

  const toggleProjector = useCallback(
    async (display?: number) => {
      setError(null);
      try {
        setProjector(projector.open && display === undefined
          ? await closeProjector()
          : await openProjector(display));
        void refreshDisplays();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [projector.open, refreshDisplays],
  );

  const active =
    status.state === "listening" || status.state === "starting" || status.state === "reconnecting";

  const toggleListening = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (active) {
        await stopTranscription();
      } else {
        // Nothing can start without credentials, so send the operator straight
        // to the place that fixes it rather than reporting a failure.
        if (!settings?.hasAzureKey || !settings.azureRegion.trim()) {
          setSettingsOpen(true);
          return;
        }
        await startTranscription();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [active, settings]);

  // Detection searches whichever translation is selected, and the Rust side
  // reads it from settings, so the choice has to be persisted rather than kept
  // in component state.
  const selectTranslation = useCallback(
    (id: string) => {
      setTranslation(id);
      if (!settings || settings.translation === id) return;
      void saveSettings({ ...settings, translation: id })
        .then(setSettings)
        .catch((err) => setError(describeError(err)));
    },
    [settings],
  );

  const selectDevice = useCallback(
    async (id: string | null) => {
      if (!settings) return;
      setSettings({ ...settings, inputDeviceId: id });
      try {
        setSettings(
          await saveSettings({ ...settings, inputDeviceId: id }),
        );
        // The device is read when a session starts, so an in-progress session
        // has to be cycled for the change to take effect mid-service.
        if (active) {
          await stopTranscription();
          await startTranscription();
        }
      } catch (err) {
        setError(describeError(err));
      }
    },
    [settings, active],
  );

  // The confirmation is transient; the status bar belongs to the live session.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const saveTranscript = useCallback(async () => {
    setError(null);
    setExporting(true);
    try {
      const path = await exportTranscript(lines, {
        device: status.device,
        language: settings?.language,
      });
      // Cancelling the dialog is not a failure and needs no message.
      if (path) setNotice(`Transcript saved to ${path}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExporting(false);
    }
  }, [lines, status.device, settings]);

  // The supervisor's own detail line is more specific than anything we'd write.
  const footer =
    error ??
    notice ??
    status.detail ??
    library.error ??
    (library.importing ? `Installing ${library.importing}\u2026` : null) ??
    (semanticIndex.state === "building" && semanticIndex.total > 0
      ? `Preparing ${semanticIndex.translation} for paraphrase matching \u2014 ${Math.floor(
          (semanticIndex.done / semanticIndex.total) * 100,
        )}%`
      : null);

  return (
    <div className="flex h-full flex-col bg-pulpitry-ink text-pulpitry-text">
      <TopBar
        status={status}
        devices={devices}
        selectedDeviceId={settings?.inputDeviceId ?? null}
        onSelectDevice={selectDevice}
        onToggleListening={() => void toggleListening()}
        onOpenSettings={() => setSettingsOpen(true)}
        busy={busy || !settings}
        displays={displays}
        projector={projector}
        onToggleProjector={(display) => void toggleProjector(display)}
        onRefreshDisplays={() => void refreshDisplays()}
      />

      <main className="grid min-h-0 flex-1 gap-2 p-2 [grid-template-columns:minmax(240px,0.95fr)_minmax(380px,1.45fr)_minmax(320px,1.1fr)]">
        <TranscriptPanel
          lines={lines}
          interim={interim}
          status={status}
          onClear={clear}
          onExport={() => void saveTranscript()}
          exporting={exporting}
        />
        <StagePanel
          preview={preview}
          live={live}
          onDisplay={display}
          onClear={clearLive}
          onStep={(forward) => void step(forward)}
          onAdd={() => preview && schedule.add(preview)}
          theme={settings?.projector ?? DEFAULT_THEME}
          canStepBack={canStepBack}
          canStepForward={canStepForward}
        />
        <ScripturePanel
          translation={translation}
          translations={library.translations}
          onSelectTranslation={selectTranslation}
          onPreview={previewVerse}
          onPreviewRange={previewVerses}
          previewVerseIds={preview?.kind === "scripture" ? preview.verses.map((verse) => verse.id) : []}
          liveVerseIds={live?.ids ?? []}
          history={history}
          schedule={schedule}
          onStageEntry={stageEntry}
          onPreviewItem={previewItem}
          keyOf={keyOf}
          previewKey={preview ? keyOf(preview) : null}
          liveKey={liveKey}
          theme={settings?.projector ?? DEFAULT_THEME}
          onError={setError}
          detections={detections}
          references={references}
          suggestions={suggestions}
          semanticIndex={semanticIndex}
          assistEnabled={settings?.assistEnabled ?? false}
          listening={active}
          libraryReady={library.ready && Boolean(translation)}
          libraryImporting={library.importing}
          libraryError={library.error}
        />
      </main>

      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-pulpitry-line bg-pulpitry-surface px-3 text-[11.5px]">
        {footer ? (
          <span
            className={
              status.state === "error" || error || library.error
                ? "text-pulpitry-gold"
                : "text-pulpitry-muted"
            }
          >
            {footer}
          </span>
        ) : (
          <span className="text-pulpitry-muted">
            {status.device ? `Listening on ${status.device}` : "Ready"}
          </span>
        )}
      </footer>

      {settingsOpen && settings ? (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      ) : null}
    </div>
  );
}
