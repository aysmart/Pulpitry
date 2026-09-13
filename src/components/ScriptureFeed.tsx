import { useState } from "react";

import {
  presentableLabel,
  presentableText,
  type Presentable,
  type Shown,
} from "../lib/usePresentation";
import { EmptyState, Panel } from "./Panel";

type Feed = "history" | "queue";

/** 13:58 rather than a date: this list never outlives the service. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What has been on the screen, and what is waiting to go back on it.
 *
 * Two lists in one pane, because they answer the two questions an operator asks
 * about scripture that is not in front of them right now — and they are not the
 * same question:
 *
 * - **History** is a record. Everything that went on the wall this session, in
 *   the order it went, newest first, with the time. Nobody puts anything here;
 *   it fills itself. It exists for "what was that verse before the last hymn" —
 *   asked, always, while the service carries on.
 * - **Queue** is an intention. Passages the operator put aside on purpose, for
 *   a preacher who says they will come back to something. It expires with the
 *   service, exactly as the history beside it does.
 *
 * The queue was the service running order until it was not. Sharing one list
 * meant a preacher doubling back three times left three verses in Sunday's
 * plan, and the plan somebody prepared on Friday was no longer the plan. The
 * running order lives on the Plan desk now; see lib/useAside.ts.
 *
 * Neither sends anything to a wall. A click stages, a double-click goes live,
 * exactly as everywhere else — the fixed strip at the top of the window owns
 * going live and there is no second path to it here.
 *
 * # Why it is scripture only
 *
 * This is the scripture desk's feed. A photograph shown during a prayer is in
 * the session's history too, and putting it in this list would make the one
 * question the list answers — which verses have we read — harder to answer.
 */
export function ScriptureFeed({
  history,
  onClearHistory,
  aside,
  onRemoveAside,
  onClearAside,
  onPreviewItem,
  keyOf,
  previewKey,
  liveKey,
}: {
  history: Shown[];
  onClearHistory: () => void;
  /** Put aside by the operator, this service only. */
  aside: Presentable[];
  onRemoveAside: (index: number) => void;
  onClearAside: () => void;
  onPreviewItem: (item: Presentable, andShow?: boolean) => void;
  keyOf: (item: Presentable) => string;
  previewKey: string | null;
  liveKey: string | null;
}) {
  const [feed, setFeed] = useState<Feed>("history");

  const verses = history.filter((shown) => shown.item.kind === "scripture");
  const counts: Record<Feed, number> = {
    history: verses.length,
    queue: aside.length,
  };

  return (
    <Panel
      tour="feed"
      title=""
      accent="teal"
      actions={
        <div className="flex w-full items-center gap-1">
          {(
            [
              ["history", "History", "Every verse shown this session"],
              ["queue", "Queue", "Passages put aside to come back to"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              title={hint}
              aria-pressed={feed === id}
              onClick={() => setFeed(id)}
              className={`rounded px-1.5 py-0.5 text-[11px] tracking-[0.08em] uppercase transition-colors focus-visible:focus-ring ${
                feed === id
                  ? "bg-pulpitry-teal-dim text-pulpitry-text"
                  : "text-pulpitry-muted hover:text-pulpitry-text"
              }`}
            >
              {label}
              {counts[id] > 0 ? (
                <span className="ml-1 text-pulpitry-teal tabular-nums">
                  {counts[id]}
                </span>
              ) : null}
            </button>
          ))}

          <span className="flex-1" />

          {/* Clears the list in front, and says which one. A single Clear on a
              pane holding two lists is the kind of button that empties the
              wrong one during a service. */}
          {counts[feed] > 0 ? (
            <button
              type="button"
              onClick={feed === "history" ? onClearHistory : onClearAside}
              title={
                feed === "history"
                  ? "Forget what has been shown this session"
                  : "Let go of everything put aside"
              }
              className="rounded px-1 text-[11px] text-pulpitry-muted transition-colors hover:bg-pulpitry-raised hover:text-pulpitry-text focus-visible:focus-ring"
            >
              Clear
            </button>
          ) : null}
        </div>
      }
    >
      {feed === "history" ? (
        verses.length === 0 ? (
          <EmptyState>
            Verses you put on the screen collect here, newest first.
          </EmptyState>
        ) : (
          <ol className="flex flex-col p-1">
            {verses.map((shown) => {
              const key = keyOf(shown.item);
              const isLive = key === liveKey;
              const isPreview = key === previewKey;
              return (
                <li key={`${key}-${shown.at}`}>
                  <button
                    type="button"
                    onClick={() => onPreviewItem(shown.item)}
                    onDoubleClick={() => onPreviewItem(shown.item, true)}
                    title="Click to stage it again, double-click to put it back on screen"
                    className={`w-full rounded border px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                      isLive
                        ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                        : isPreview
                          ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim"
                          : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-[11px] ${
                          isLive ? "text-pulpitry-gold" : "text-pulpitry-muted"
                        }`}
                      >
                        {presentableLabel(shown.item)}
                      </span>
                      <span className="shrink-0 text-[10.5px] text-pulpitry-muted tabular-nums">
                        {clock(shown.at)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-pulpitry-text">
                      {presentableText(shown.item)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )
      ) : (
        aside.length === 0 ? (
        <EmptyState>
          Passages you add to the queue wait here, for when the preacher says
          they will come back to something.
        </EmptyState>
      ) : (
        <ol className="flex flex-col p-1">
          {aside.map((item, index) => {
            const key = keyOf(item);
            const isLive = key === liveKey;
            const isPreview = key === previewKey;
            return (
              /* The row and its remove control side by side rather than
                 nested: a button inside a button is invalid HTML whose inner
                 clicks browsers deliver inconsistently, and the Original panel
                 lost a whole feature to exactly that. */
              <li key={`${key}-${index}`} className="group flex items-stretch gap-1">
                <button
                  type="button"
                  onClick={() => onPreviewItem(item)}
                  onDoubleClick={() => onPreviewItem(item, true)}
                  title="Click to stage it, double-click to put it on screen"
                  className={`min-w-0 flex-1 rounded border px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                    isLive
                      ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                      : isPreview
                        ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim"
                        : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                  }`}
                >
                  <span
                    className={`block truncate text-[11px] ${
                      isLive ? "text-pulpitry-gold" : "text-pulpitry-muted"
                    }`}
                  >
                    {presentableLabel(item)}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-pulpitry-text">
                    {presentableText(item)}
                  </span>
                </button>

                {/* On hover and on keyboard focus, as everywhere else a list
                    row can be removed: a column of crosses is noise in a list
                    that is read far more often than it is edited. */}
                <button
                  type="button"
                  onClick={() => onRemoveAside(index)}
                  title="Let this one go"
                  aria-label={`Stop keeping ${presentableLabel(item)} aside`}
                  className="shrink-0 rounded px-1.5 text-[13px] leading-none text-pulpitry-muted opacity-0 transition-opacity hover:bg-pulpitry-raised hover:text-pulpitry-text focus-visible:opacity-100 focus-visible:focus-ring group-hover:opacity-100"
                >
                  &times;
                </button>
              </li>
            );
          })}
        </ol>
      )
      )}
    </Panel>
  );
}
