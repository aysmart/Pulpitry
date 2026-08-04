import { useState } from "react";

import type { Translation, Verse } from "../lib/bible";
import { presentableLabel, presentableText, type Presentable } from "../lib/usePresentation";
import type { Detection } from "../lib/useDetections";
import type { SpokenReference } from "../lib/useSpokenReferences";
import { ChapterNavigator } from "./ChapterNavigator";
import type { ProjectorTheme } from "../lib/theme";
import type { IndexStatus } from "../lib/useSemanticIndex";
import type { Suggestion } from "../lib/useSuggestions";
import type { Ticker } from "../lib/projector";
import type { ScheduleController } from "../lib/useSchedule";
import { DetectedVerses } from "./DetectedVerses";
import { MediaLibrary } from "./MediaLibrary";
import { ParaphraseMatches } from "./ParaphraseMatches";
import { SchedulePanel } from "./SchedulePanel";
import { SlideLibrary } from "./SlideLibrary";
import { TickerPanel } from "./TickerPanel";
import { TemplateLibrary } from "./TemplateLibrary";
import { SongLibrary } from "./SongLibrary";
import { EmptyState, Panel } from "./Panel";

const TABS = [
  "Scripture",
  "Songs",
  "Media",
  "Slides",
  "Detected",
  "Paraphrase",
  "Schedule",
  "History",
  "Themes",
] as const;
type Tab = (typeof TABS)[number];

/**
 * The verse column. Everything here belongs to the scripture/detection system,
 * so it carries the teal accent rather than the gold reserved for live output.
 */
export function ScripturePanel({
  translation,
  translations,
  onSelectTranslation,
  onPreview,
  onPreviewRange,
  previewVerseIds,
  liveVerseIds,
  history,
  schedule,
  onStageEntry,
  onPreviewItem,
  keyOf,
  previewKey,
  liveKey,
  theme,
  onApplyTheme,
  ticker,
  onTickerChange,
  onError,
  detections,
  references,
  suggestions,
  semanticIndex,
  assistEnabled,
  listening,
  libraryReady,
  libraryImporting,
  libraryError,
}: {
  translation: string;
  translations: Translation[];
  onSelectTranslation: (id: string) => void;
  onPreview: (verse: Verse) => void;
  onPreviewRange: (verses: Verse[]) => void;
  previewVerseIds: number[];
  liveVerseIds: number[];
  history: Presentable[];
  schedule: ScheduleController;
  onStageEntry: (index: number) => Promise<Presentable | null>;
  onPreviewItem: (item: Presentable) => void;
  keyOf: (item: Presentable) => string;
  previewKey: string | null;
  liveKey: string | null;
  theme: ProjectorTheme;
  onApplyTheme: (theme: ProjectorTheme) => void;
  ticker: Ticker;
  onTickerChange: (next: Partial<Ticker>) => void;
  onError: (message: string) => void;
  detections: Detection[];
  references: SpokenReference[];
  suggestions: Suggestion[];
  semanticIndex: IndexStatus;
  assistEnabled: boolean;
  listening: boolean;
  libraryReady: boolean;
  libraryImporting: string | null;
  libraryError: string | null;
}) {
  const [tab, setTab] = useState<Tab>("Scripture");
  // Both are text written for the congregation to read; one replaces the
  // screen and one runs along the edge of it.
  const [slidesMode, setSlidesMode] = useState<"slides" | "notice">("slides");

  return (
    <Panel
      // The tabs say what this panel holds; a "LIBRARY" heading beside them
      // would only take width the seventh tab needs.
      title=""
      accent="teal"
      bodyClassName={
        tab === "Detected" || tab === "Paraphrase" || tab === "History" ? "" : "overflow-hidden"
      }
      actions={
        <div className="flex flex-wrap justify-end gap-0">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              className={`rounded px-[2px] py-0.5 text-[10.5px] transition-colors focus-visible:focus-ring ${
                tab === name
                  ? "bg-pulpitry-teal-dim text-pulpitry-text"
                  : "text-pulpitry-muted hover:text-pulpitry-text"
              }`}
            >
              {name}
              {name === "Detected" && detections.length + references.length > 0 ? (
                <span className="ml-1 text-pulpitry-teal tabular-nums">
                  {detections.length + references.length}
                </span>
              ) : null}
              {name === "Paraphrase" && suggestions.length > 0 ? (
                <span className="ml-1 text-pulpitry-teal tabular-nums">{suggestions.length}</span>
              ) : null}
              {name === "Schedule" && schedule.entries.length > 0 ? (
                <span className="ml-1 text-pulpitry-teal tabular-nums">
                  {schedule.entries.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      }
    >
      {tab === "Scripture" ? (
        libraryError ? (
          <EmptyState>{libraryError}</EmptyState>
        ) : !libraryReady ? (
          <EmptyState>
            {libraryImporting
              ? `Installing ${libraryImporting}…`
              : "Preparing the verse library…"}
          </EmptyState>
        ) : (
          <ChapterNavigator
            translation={translation}
            translations={translations}
            onSelectTranslation={onSelectTranslation}
            onPreview={onPreview}
            onPreviewRange={onPreviewRange}
            previewVerseIds={previewVerseIds}
            liveVerseIds={liveVerseIds}
          />
        )
      ) : null}

      {tab === "Songs" ? (
        <SongLibrary
          theme={theme}
          onPreview={onPreviewItem}
          previewKey={previewKey}
          liveKey={liveKey}
          keyOf={keyOf}
          onError={onError}
        />
      ) : null}

      {tab === "Themes" ? (
        <TemplateLibrary theme={theme} onApply={onApplyTheme} onError={onError} />
      ) : null}

      {tab === "Slides" ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 gap-1.5 border-b border-pulpitry-line px-2.5 py-2">
            {(
              [
                ["slides", "Slides"],
                ["notice", "Notice"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSlidesMode(mode)}
                className={`rounded px-2 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
                  slidesMode === mode
                    ? "bg-pulpitry-teal-dim text-pulpitry-text"
                    : "text-pulpitry-muted hover:text-pulpitry-text"
                }`}
              >
                {label}
                {mode === "notice" && ticker.visible ? (
                  <span className="ml-1 text-pulpitry-gold">•</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {slidesMode === "slides" ? (
              <SlideLibrary
                theme={theme}
                onPreview={onPreviewItem}
                previewKey={previewKey}
                liveKey={liveKey}
                keyOf={keyOf}
                onError={onError}
              />
            ) : (
              <TickerPanel ticker={ticker} theme={theme} onChange={onTickerChange} />
            )}
          </div>
        </div>
      ) : null}

      {tab === "Media" ? (
        <MediaLibrary
          onPreview={onPreviewItem}
          previewKey={previewKey}
          liveKey={liveKey}
          keyOf={keyOf}
          onError={onError}
        />
      ) : null}

      {tab === "Schedule" ? (
        <SchedulePanel
          services={schedule.services}
          openId={schedule.openId}
          name={schedule.name}
          entries={schedule.entries}
          saving={schedule.saving}
          saveError={schedule.saveError}
          onCreate={() => void schedule.create()}
          onOpen={(id) => void schedule.open(id)}
          onRename={schedule.rename}
          onDelete={(id) => void schedule.remove(id)}
          onAddNote={schedule.addNote}
          onRemoveAt={schedule.removeAt}
          onMove={schedule.move}
          onRelabel={schedule.relabel}
          onStage={onStageEntry}
        />
      ) : null}

      {tab === "History" ? (
        history.length === 0 ? (
          <EmptyState>Verses you put on the projector will collect here.</EmptyState>
        ) : (
          <div className="flex flex-col p-1">
            {history.map((item) => (
              <button
                key={keyOf(item)}
                type="button"
                onClick={() => onPreviewItem(item)}
                className="rounded px-2 py-1.5 text-left transition-colors hover:bg-pulpitry-raised focus-visible:focus-ring"
              >
                <span className="block text-[11px] text-pulpitry-muted">
                  {presentableLabel(item)}
                </span>
                <span className="line-clamp-2 text-[12.5px] text-pulpitry-text">
                  {presentableText(item)}
                </span>
              </button>
            ))}
          </div>
        )
      ) : null}

      {tab === "Detected" ? (
        <DetectedVerses
          detections={detections}
          references={references}
          onPreview={onPreview}
          previewVerseId={previewVerseIds[0] ?? null}
          liveVerseId={liveVerseIds[0] ?? null}
          listening={listening}
        />
      ) : null}

      {tab === "Paraphrase" ? (
        <ParaphraseMatches
          suggestions={suggestions}
          onPreview={onPreview}
          previewVerseId={previewVerseIds[0] ?? null}
          liveVerseId={liveVerseIds[0] ?? null}
          index={semanticIndex}
          assistEnabled={assistEnabled}
          listening={listening}
        />
      ) : null}
    </Panel>
  );
}
