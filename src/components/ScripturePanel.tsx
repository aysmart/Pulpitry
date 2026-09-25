import { useState } from "react";

import type { Translation, Verse } from "../lib/bible";
import type { Presentable } from "../lib/usePresentation";
import type { IndexStatus } from "../lib/useSemanticIndex";
import { ChapterNavigator } from "./ChapterNavigator";
import type { ProjectorTheme } from "../lib/theme";
import type { Ticker } from "../lib/projector";
import type { ScheduleController } from "../lib/useSchedule";
import { ComparePanel } from "./ComparePanel";
import { MediaLibrary } from "./MediaLibrary";
import { SchedulePanel } from "./SchedulePanel";
import { SlideLibrary } from "./SlideLibrary";
import { TickerPanel } from "./TickerPanel";
import { SongLibrary } from "./SongLibrary";
import type { LibraryTab } from "../lib/workspaces";
import { EmptyState, Panel } from "./Panel";

/**
 * Which libraries are offered, and in what order, comes from the arrangement.
 *
 * All seven used to be on screen whatever the operator was doing. See
 * lib/workspaces.ts, which owns both the list of names and the choice.
 */
export type Tab = LibraryTab;

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
  index,
  follow,
  schedule,
  onStageEntry,
  onPreviewItem,
  keyOf,
  previewKey,
  staged,
  liveKey,
  theme,
  onApplyTheme,
  ticker,
  onTickerChange,
  onError,
  libraryReady,
  libraryImporting,
  libraryError,
  onAddToSet,
  tab: chosenTab,
  tabs,
  onTab,
}: {
  translation: string;
  translations: Translation[];
  onSelectTranslation: (id: string) => void;
  onPreview: (verse: Verse, andShow?: boolean) => void;
  onPreviewRange: (verses: Verse[], andShow?: boolean) => void;
  previewVerseIds: number[];
  liveVerseIds: number[];
  /** The embedding index, which the Bible pane searches by meaning. */
  index: IndexStatus;
  /** The staged verse the chapter list should follow. */
  follow: Verse | null;
  schedule: ScheduleController;
  onStageEntry: (
    index: number,
    andShow?: boolean,
  ) => Promise<Presentable | null>;
  onPreviewItem: (item: Presentable, andShow?: boolean) => void;
  keyOf: (item: Presentable) => string;
  previewKey: string | null;
  /** What this desk has staged, for the panes that work on it rather than
   *  on a library: Compare reads the passage in other translations. */
  staged: Presentable | null;
  liveKey: string | null;
  theme: ProjectorTheme;
  onApplyTheme: (theme: ProjectorTheme) => void;
  ticker: Ticker;
  onTickerChange: (next: Partial<Ticker>) => void;
  onError: (message: string) => void;
  libraryReady: boolean;
  libraryImporting: string | null;
  libraryError: string | null;
  /**
   * Puts a song straight into the set being built, without staging it.
   *
   * Only the song desk passes one: it is the arrangement with a set in front
   * of the operator, and a plus on a song row anywhere else would add to a
   * list that is not on screen.
   */
  onAddToSet?: (item: Presentable) => void;
  /** Which library is in front. Held by the desk, so a workspace can set it. */
  tab: Tab;
  /** The ones this arrangement offers, in order. */
  tabs: Tab[];
  onTab: (tab: Tab) => void;
}) {
  /*
   * Held by the caller, not here.
   *
   * A workspace chooses which library is in front: switching to Songs on the
   * desk has to move this too, or the arrangement would give the width to a
   * library the operator is not looking at. Pressing a tab still works and
   * still wins -- it just tells the same state.
   */
  const tab = chosenTab;
  // Both are text written for the congregation to read; one replaces the
  // screen and one runs along the edge of it.
  const [slidesMode, setSlidesMode] = useState<"slides" | "notice">("slides");

  /*
   * One library means no chooser.
   *
   * A strip of tabs with a single tab in it is a control that cannot do
   * anything, and it takes the header width that the panel's own name should
   * have. The Scripture arrangement is exactly that case: its pane is the
   * Bible.
   */
  const choosing = tabs.length > 1;

  return (
    <Panel
      tour="library"
      // The tabs say what this panel holds; a "LIBRARY" heading beside them
      // would only take width the seventh tab needs. With nothing to choose
      // between, the one name becomes the heading instead.
      title={choosing ? "" : tab}
      accent="teal"
      bodyClassName="overflow-hidden"
      actions={
        !choosing ? null : (
        <div className="flex flex-wrap justify-end gap-0">
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              data-tour={`tab-${name}`}
              onClick={() => onTab(name)}
              className={`rounded px-[2px] py-0.5 text-[10.5px] transition-colors focus-visible:focus-ring ${
                tab === name
                  ? "bg-pulpitry-teal-dim text-pulpitry-text"
                  : "text-pulpitry-muted hover:text-pulpitry-text"
              }`}
            >
              {name}
              {name === "Schedule" && schedule.entries.length > 0 ? (
                <span className="ml-1 text-pulpitry-teal tabular-nums">
                  {schedule.entries.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        )
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
            index={index}
            follow={follow}
          />
        )
      ) : null}

      {tab === "Compare" ? (
        <ComparePanel
          staged={staged}
          translations={translations}
          reading={translation}
          onPreviewItem={onPreviewItem}
          onError={onError}
        />
      ) : null}

      {tab === "Songs" ? (
        <SongLibrary
          theme={theme}
          onApplyTheme={onApplyTheme}
          onPreview={onPreviewItem}
          onAddToSet={onAddToSet}
          previewKey={previewKey}
          liveKey={liveKey}
          keyOf={keyOf}
          onError={onError}
        />
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
                translation={translation}
                onPreview={onPreviewItem}
                previewKey={previewKey}
                liveKey={liveKey}
                keyOf={keyOf}
                onError={onError}
              />
            ) : (
              <TickerPanel
                ticker={ticker}
                theme={theme}
                onChange={onTickerChange}
              />
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

    </Panel>
  );
}
