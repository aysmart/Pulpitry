import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { AboutDialog } from "./components/AboutDialog";
import { HistoryDialog } from "./components/HistoryDialog";
import { Detections } from "./components/Detections";
import { OriginalPanel } from "./components/OriginalPanel";
import { Panel } from "./components/Panel";
import { QueueRail } from "./components/QueueRail";
import { ScripturePanel } from "./components/ScripturePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { SlidesFromSermon } from "./components/SlidesFromSermon";
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
  openSecond,
  closeSecond,
  secondState,
  projectorState,
  bodyText,
  type Display,
  type ProjectorState,
  type SecondState,
} from "./lib/projector";
import { exportTranscript } from "./lib/exportTranscript";
import { DEFAULT_THEME } from "./lib/theme";
import { useDetections } from "./lib/useDetections";
import { usePresentation } from "./lib/usePresentation";
import { useAudio } from "./lib/useAudio";
import { useMedia } from "./lib/useMedia";
import { useSchedule } from "./lib/useSchedule";
import { useTicker } from "./lib/useTicker";
import { useSemanticIndex } from "./lib/useSemanticIndex";
import { useSpokenReferences } from "./lib/useSpokenReferences";
import { useSuggestions } from "./lib/useSuggestions";
import { useTranscript } from "./lib/useTranscript";

/**
 * Whether the chosen engine has what it needs to start.
 *
 * Each wants something different: Azure a key and a region, this machine a
 * model that has been downloaded, a subscription an activated licence. Nothing
 * here checks that they are *correct* -- only that the operator has been asked.
 */
function ready(settings: SettingsView | null): boolean {
  if (!settings) return false;
  switch (settings.speechEngine) {
    case "local":
      return settings.speechModel.trim().length > 0;
    case "hosted":
      return settings.hasHostedSubscription;
    default:
      return settings.hasAzureKey && settings.azureRegion.trim().length > 0;
  }
}

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
    showVerse,
    showVerses,
    showItem,
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<Display[]>([]);
  const [projector, setProjector] = useState<ProjectorState>({ open: false, display: null });
  const [second, setSecond] = useState<SecondState>({ open: false, display: null });

  // The running order. Kept in the library rather than in state, so closing
  // the app mid-service does not cost the plan.
  const schedule = useSchedule(setError);
  const { audio, change: changeAudio } = useAudio();
  const media = useMedia();
  const { ticker, change: changeTicker } = useTicker();

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
      const [found, state, onSecond] = await Promise.all([
        listDisplays(),
        projectorState(),
        secondState(),
      ]);
      setDisplays(found);
      setProjector(state);
      setSecond(onSecond);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refreshDisplays();
  }, [refreshDisplays]);

  /*
   * The second display, kept independent of the projector.
   *
   * A church may want one, the other, or both, and the second belongs on a
   * screen the first is not using. Tying them together would be deciding for
   * them.
   */
  const toggleSecond = useCallback(
    async (display?: number) => {
      setError(null);
      try {
        setSecond(second.open && display === undefined
          ? await closeSecond()
          : await openSecond(display));
      } catch (err) {
        setError(describeError(err));
      }
    },
    [second.open],
  );

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
        // Nothing can start without whatever the chosen engine needs, so send
        // the operator straight to the place that fixes it rather than
        // reporting a failure.
        //
        // What counts as ready depends on the engine, and asking for an Azure
        // key regardless -- as this did -- sent anyone transcribing on this
        // machine to Settings to enter a key they had rightly never bought.
        if (!ready(settings)) {
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

  /**
   * Applies a whole look at once.
   *
   * Saved rather than held locally: the projector window reads the theme from
   * settings, so a template that only changed this window would leave the two
   * disagreeing about what the congregation is looking at.
   */
  const applyTheme = useCallback(
    (projector: typeof DEFAULT_THEME) => {
      if (!settings) return;
      void saveSettings({ ...settings, projector })
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

  /*
   * The menu bar, answered here.
   *
   * Every one of these has a button in the window that already knows the state
   * it changes -- whether the projector is open, whether the microphone is
   * running. Doing the work again from a menu handler would be a second
   * implementation of each, and the two would disagree the first time either
   * changed. So the menu chooses and this dispatches to what the buttons call.
   */
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;

    void listen<string>("menu:chose", (event) => {
      switch (event.payload) {
        case "about":
          setAboutOpen(true);
          break;
        case "settings":
          setSettingsOpen(true);
          break;
        case "history":
          setHistoryOpen(true);
          break;
        case "slides":
          setSlidesOpen(true);
          break;
        case "mirror":
          // The mirror lives inside Settings rather than in a dialog of its
          // own, so this opens the page it is on.
          setSettingsOpen(true);
          break;
        case "projector":
          void toggleProjector();
          break;
        case "second":
          void toggleSecond();
          break;
        case "listen":
          void toggleListening();
          break;
        case "clear":
          clearLive();
          break;
      }
    }).then((off) => {
      if (active) stop = off;
      else off();
    });

    return () => {
      active = false;
      stop?.();
    };
  }, [toggleProjector, toggleSecond, toggleListening, clearLive]);

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
        second={second}
        onToggleSecond={(display) => void toggleSecond(display)}
        onToggleProjector={(display) => void toggleProjector(display)}
        onRefreshDisplays={() => void refreshDisplays()}
      />

      {/*
        The two controls that must never move.
        
        Putting something live and clearing the screen are the only actions
        taken in a hurry, and until now both lived inside the stage panel --
        which is fine while nothing else is happening, and wrong the moment a
        photograph is on the wall through a prayer and the operator is looking
        at the song library. A fixed strip means the hand knows where to go
        without the eye having to find it.
        
        Clear is drawn as the louder of the two on purpose. Going live is a
        decision somebody has already made; clearing is the one taken under
        pressure.
      */}
      <div className="flex shrink-0 items-center gap-2 border-b border-pulpitry-line bg-pulpitry-surface px-3 py-1.5">
        <button
          type="button"
          disabled={!preview}
          onClick={() => display()}
          className="rounded border border-pulpitry-teal/40 bg-pulpitry-teal/10 px-3 py-1 text-[12px] font-medium text-pulpitry-teal disabled:opacity-30 focus-visible:focus-ring"
        >
          Go live
        </button>
        <button
          type="button"
          disabled={!live}
          onClick={() => clearLive()}
          className="rounded border border-pulpitry-gold-dim bg-pulpitry-gold/10 px-3 py-1 text-[12px] font-medium text-pulpitry-gold disabled:opacity-30 focus-visible:focus-ring"
        >
          Clear the screen
        </button>

        {/*
          The reason "Go live" can look broken.
          
          Sending works whether or not a projector window is open -- the content
          is stored either way -- but with no window there is nothing to see, so
          the operator presses it, nothing happens anywhere, and concludes the
          button is dead. It is not; there is simply no screen to send to. Said
          here, with the fix beside it.
        */}
        {!projector.open ? (
          <button
            type="button"
            onClick={() => void toggleProjector()}
            className="rounded border border-pulpitry-gold-dim px-2 py-1 text-[11.5px] text-pulpitry-gold focus-visible:focus-ring"
          >
            No projector open — open one
          </button>
        ) : null}

        <span className="ml-2 min-w-0 truncate text-[11.5px] text-pulpitry-muted">
          {live ? (
            <>
              <span className="text-pulpitry-gold">On screen</span>{" "}
              {live.caption || bodyText(live.body).slice(0, 80)}
            </>
          ) : (
            "Nothing on screen"
          )}
        </span>
      </div>

      {/*
        Two rows, because the operator does two different things.
        
        The top row is the decision: what was said, what scripture that turned
        out to be, and what is on the wall. The bottom row is the search --
        browsing a chapter, finding a song, picking a slide. Those were side by
        side in three equal columns, which meant the thing being decided and the
        thing being looked for competed for the same width and the eye had no
        anchor.
        
        Detections were a tab inside the library, one click away from the
        operator at the moment they were most needed. They are their own panel
        now, permanently visible beside the transcript that produced them.
      */}
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <div className="grid min-h-0 flex-1 gap-2 [grid-template-columns:minmax(200px,0.7fr)_minmax(240px,0.9fr)_minmax(360px,1.5fr)_minmax(180px,0.6fr)]">
        <TranscriptPanel
          lines={lines}
          interim={interim}
          status={status}
          onClear={clear}
          onExport={() => void saveTranscript()}
          onOpenHistory={() => setHistoryOpen(true)}
          exporting={exporting}
        />
        <Panel
          title="Detected"
          actions={
            detections.length + references.length + suggestions.length > 0 ? (
              <span className="text-[11px] text-pulpitry-muted tabular-nums">
                {detections.length + references.length + suggestions.length}
              </span>
            ) : undefined
          }
        >
          <Detections
            detections={detections}
            references={references}
            suggestions={suggestions}
            onPreview={(verse, andShow) => (andShow ? showVerse(verse) : previewVerse(verse))}
            previewVerseId={
              preview?.kind === "scripture" ? (preview.verses[0]?.id ?? null) : null
            }
            liveVerseId={live?.ids?.[0] ?? null}
            listening={active}
            index={semanticIndex}
            assistEnabled={settings?.assistEnabled ?? false}
          />
        </Panel>

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
          projectorOpen={projector.open}
          audio={audio}
          onAudioChange={changeAudio}
          media={media}
          ticker={ticker}
        />
        <Panel
          title="Queue"
          actions={
            schedule.entries.length > 0 ? (
              <span className="text-[11px] text-pulpitry-muted tabular-nums">
                {schedule.entries.length}
              </span>
            ) : undefined
          }
        >
          <QueueRail
            entries={schedule.entries}
            name={schedule.name}
            onStage={(index) => void stageEntry(index)}
            activeLabel={live?.caption || null}
          />
        </Panel>
        </div>

        {/* Fixed share of the height rather than a third of the width: a
            chapter is read down, not across, and eight verses visible beats
            three. */}
        <div className="grid min-h-0 basis-[38%] gap-2 [grid-template-columns:1fr_minmax(240px,0.5fr)]">
        <ScripturePanel
          translation={translation}
          translations={library.translations}
          onSelectTranslation={selectTranslation}
          onPreview={(verse, andShow) => (andShow ? showVerse(verse) : previewVerse(verse))}
          onPreviewRange={(verses, andShow) => (andShow ? showVerses(verses) : previewVerses(verses))}
          previewVerseIds={preview?.kind === "scripture" ? preview.verses.map((verse) => verse.id) : []}
          liveVerseIds={live?.ids ?? []}
          history={history}
          schedule={schedule}
          onStageEntry={stageEntry}
          onPreviewItem={(item, andShow) => (andShow ? showItem(item) : previewItem(item))}
          keyOf={keyOf}
          previewKey={preview ? keyOf(preview) : null}
          liveKey={liveKey}
          theme={settings?.projector ?? DEFAULT_THEME}
          onApplyTheme={applyTheme}
          ticker={ticker}
          onTickerChange={changeTicker}
          onError={setError}
          libraryReady={library.ready && Boolean(translation)}
          libraryImporting={library.importing}
          libraryError={library.error}
        />

        {/*
          Beside the library rather than in the rail.
          
          A verse laid out word by word needs width -- cards wrap, and in a
          narrow rail every one of them would be a column one word wide. It also
          belongs next to the thing it explains: an operator reading a chapter
          is the operator who wants to know what a word is doing in it.
        */}
        <Panel title="Original">
          <OriginalPanel
            verse={preview?.kind === "scripture" ? (preview.verses[0] ?? null) : null}
            onStage={(word, reference, andShow) => {
              /*
               * Three lines: the word, how to say it, what it means. Not the
               * Strong's number and not the morphology -- those are how the
               * operator knows they have the right word, and a congregation
               * reading "V-AAI-3S" has been shown our workings rather than the
               * point.
               */
              const item = {
                kind: "slide" as const,
                itemId: -1,
                title: `${word.original} — ${reference}`,
                blocks: [
                  {
                    text: word.original,
                    level: "heading" as const,
                    align: "center" as const,
                    bold: true,
                    italic: false,
                  },
                  ...(word.transliteration
                    ? [{
                        text: word.transliteration,
                        level: "body" as const,
                        align: "center" as const,
                        bold: false,
                        italic: true,
                      }]
                    : []),
                  ...(word.gloss
                    ? [{
                        text: word.gloss,
                        level: "body" as const,
                        align: "center" as const,
                        bold: false,
                        italic: false,
                      }]
                    : []),
                ],
              };
              if (andShow) showItem(item);
              else previewItem(item);
            }}
          />
        </Panel>
        </div>
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

      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}

      {slidesOpen ? <SlidesFromSermon onClose={() => setSlidesOpen(false)} /> : null}

      {historyOpen ? (
        <HistoryDialog
          onClose={() => setHistoryOpen(false)}
          engine={settings?.speechEngine ?? "azure"}
        />
      ) : null}

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
