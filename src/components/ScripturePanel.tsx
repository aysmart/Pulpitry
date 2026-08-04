import { useState } from "react";

import type { Translation, Verse } from "../lib/bible";
import { presentableLabel, presentableText, type Presentable } from "../lib/usePresentation";
import type { Detection } from "../lib/useDetections";
import type { SpokenReference } from "../lib/useSpokenReferences";
import { ChapterNavigator } from "./ChapterNavigator";
import type { ProjectorTheme } from "../lib/theme";
import type { IndexStatus } from "../lib/useSemanticIndex";
import type { Suggestion } from "../lib/useSuggestions";
import { DetectedVerses } from "./DetectedVerses";
import { ParaphraseMatches } from "./ParaphraseMatches";
import { SongLibrary } from "./SongLibrary";
import { EmptyState, Panel } from "./Panel";

const TABS = ["Scripture", "Songs", "Detected", "Paraphrase", "Queue", "History"] as const;
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
  queue,
  onDequeue,
  onPreviewItem,
  keyOf,
  previewKey,
  liveKey,
  theme,
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
  queue: Presentable[];
  onDequeue: (key: string) => void;
  onPreviewItem: (item: Presentable) => void;
  keyOf: (item: Presentable) => string;
  previewKey: string | null;
  liveKey: string | null;
  theme: ProjectorTheme;
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

  return (
    <Panel
      title="Library"
      accent="teal"
      bodyClassName={tab === "Scripture" || tab === "Songs" ? "overflow-hidden" : ""}
      actions={
        <div className="flex gap-0.5">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              className={`rounded px-1.5 py-0.5 text-[11px] transition-colors focus-visible:focus-ring ${
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
              {name === "Queue" && queue.length > 0 ? (
                <span className="ml-1 text-pulpitry-teal tabular-nums">{queue.length}</span>
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

      {tab === "Queue" ? (
        queue.length === 0 ? (
          <EmptyState>
            Stage a verse and press Queue to line it up. The running order empties as you
            display each one.
          </EmptyState>
        ) : (
          <ol className="flex flex-col p-1">
            {queue.map((item, position) => (
              <li key={keyOf(item)} className="flex items-start gap-1">
                <button
                  type="button"
                  onClick={() => onPreviewItem(item)}
                  className="min-w-0 flex-1 rounded px-2 py-1.5 text-left transition-colors hover:bg-pulpitry-raised focus-visible:focus-ring"
                >
                  <span className="block text-[11px] text-pulpitry-muted">
                    <span className="mr-1.5 tabular-nums">{position + 1}.</span>
                    {presentableLabel(item)}
                  </span>
                  <span className="line-clamp-2 text-[12.5px] text-pulpitry-text">
                    {presentableText(item)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDequeue(keyOf(item))}
                  aria-label={`Remove ${presentableLabel(item)} from the queue`}
                  className="mt-1.5 shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )
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
