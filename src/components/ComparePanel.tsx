import { useCallback, useEffect, useState } from "react";

import { scriptureIn, type Translation } from "../lib/bible";
import { describeError } from "../lib/api";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";

const KEY = "pulpitry.compare";

/**
 * Which translations a church compares in.
 *
 * Per machine rather than in the settings file, for the same reason the
 * arrangement is: it is a habit of the person at the desk -- the two versions
 * their preacher moves between -- rather than something a church decides once
 * and everybody inherits.
 */
function remembered(fallback: string[]): string[] {
  try {
    const held = localStorage.getItem(KEY);
    const parsed: unknown = held ? JSON.parse(held) : null;
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string"))
      return parsed as string[];
  } catch {
    // Storage off, or something else's data under our key. The default reads.
  }
  return fallback;
}

function remember(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // It falls back to the desk's own translation next launch, which is right.
  }
}

/** The passage as a reference another translation can be asked for. */
function referenceOf(item: Presentable | null): string {
  if (!item || item.kind !== "scripture") return "";
  const first = item.verses[0];
  const last = item.verses[item.verses.length - 1];
  if (!first || !last) return "";
  return first.verse === last.verse
    ? `${first.book} ${first.chapter}:${first.verse}`
    : `${first.book} ${first.chapter}:${first.verse}-${last.verse}`;
}

/**
 * One passage, in several translations at once.
 *
 * # What it is for
 *
 * Two questions, and only one of them is about the screen. An operator
 * checking a wording before it goes up -- "does the NASB say servant or
 * slave" -- and a preacher who asks from the platform. Neither is answered by
 * changing the desk's translation and changing it back, which loses the place
 * and re-stages the verse twice.
 *
 * # Reading and showing are separate
 *
 * Read here, column against column. Put up as a table, because a comparison
 * *is* one and the wall already draws composed tables with their own hairlines
 * -- so this invents no layout and inherits every look the church has set.
 *
 * Nothing is compared from a model. Each column is the passage fetched from
 * that translation's own library, and a translation that does not have the
 * passage says so rather than being filled in.
 */
export function ComparePanel({
  staged,
  translations,
  reading,
  onPreviewItem,
  onError,
}: {
  /** What the desk has staged; only scripture can be compared. */
  staged: Presentable | null;
  translations: Translation[];
  /** The desk's own translation, which is always one of the columns. */
  reading: string;
  onPreviewItem: (item: Presentable, andShow?: boolean) => void;
  onError: (message: string) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(() => remembered([reading]));
  const [columns, setColumns] = useState<
    { id: string; lines: { number: number; text: string }[]; missing: boolean }[]
  >([]);
  const [looking, setLooking] = useState(false);

  const reference = referenceOf(staged);

  // The desk's own translation is always shown: a comparison that did not
  // include what is staged would be comparing two things against neither.
  const showing = [reading, ...chosen.filter((id) => id !== reading)];

  useEffect(() => {
    if (!reference) {
      setColumns([]);
      return;
    }
    let live = true;
    setLooking(true);
    void Promise.all(
      showing.map(async (id) => {
        try {
          const passage = await scriptureIn(id, reference);
          return {
            id,
            lines: passage.lines,
            missing: passage.lines.length === 0,
          };
        } catch {
          return { id, lines: [], missing: true };
        }
      }),
    )
      .then((found) => live && setColumns(found))
      .catch((err) => live && onError(describeError(err)))
      .finally(() => live && setLooking(false));
    return () => {
      live = false;
    };
    // `showing` is derived from these two; listing it would refetch on every
    // render, which is a request per keystroke somewhere else in the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, chosen.join(","), reading]);

  const toggle = useCallback(
    (id: string) => {
      setChosen((was) => {
        const next = was.includes(id)
          ? was.filter((held) => held !== id)
          : [...was, id];
        remember(next);
        return next;
      });
    },
    [],
  );

  /**
   * The comparison as a slide.
   *
   * A table component, which is what it is: the wall draws those already, with
   * the church's own hairlines and type. Verse numbers lead each row, because
   * a reader following two columns needs to know which line they are on in
   * both.
   */
  const asSlide = (): Presentable | null => {
    const withText = columns.filter((column) => !column.missing);
    if (withText.length === 0) return null;

    const numbers = withText[0]!.lines.map((line) => line.number);
    const rows = numbers.map((number) => [
      String(number),
      ...withText.map(
        (column) =>
          column.lines.find((line) => line.number === number)?.text ?? "",
      ),
    ]);

    return {
      kind: "slide",
      // Ad-hoc, as the lexicon's definitions are: built from what is staged
      // rather than saved in the library, because a comparison is a question
      // asked once.
      itemId: -1,
      title: reference,
      blocks: [],
      components: [
        {
          kind: "table",
          header: ["", ...withText.map((column) => column.id)],
          rows,
        },
      ],
      layout: "stacked",
    };
  };

  if (!staged || staged.kind !== "scripture") {
    return (
      <EmptyState>
        Stage a verse and it appears here in every translation you pick — for
        checking a wording before it goes up, and for answering the question
        from the platform.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pulpitry-line px-2.5 py-2">
        <span className="mr-1 text-[12px] text-pulpitry-text">{reference}</span>
        {translations.map((entry) => {
          const on = showing.includes(entry.id);
          const fixed = entry.id === reading;
          return (
            <button
              key={entry.id}
              type="button"
              disabled={fixed}
              onClick={() => toggle(entry.id)}
              title={
                fixed
                  ? `${entry.name} — what this desk is reading`
                  : on
                    ? `Stop comparing with ${entry.name}`
                    : `Compare with ${entry.name}`
              }
              className={`rounded border px-1.5 py-0.5 text-[11.5px] transition-colors focus-visible:focus-ring ${
                on
                  ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim text-pulpitry-text"
                  : "border-pulpitry-line text-pulpitry-muted hover:text-pulpitry-text"
              } ${fixed ? "opacity-70" : ""}`}
            >
              {entry.id}
            </button>
          );
        })}

        <span className="flex-1" />

        {/* One click stages it, two puts it up — the rule every list in this
            window follows, kept by the thing that is not a list. */}
        <button
          type="button"
          disabled={columns.every((column) => column.missing)}
          onClick={() => {
            const slide = asSlide();
            if (slide) onPreviewItem(slide);
          }}
          onDoubleClick={() => {
            const slide = asSlide();
            if (slide) onPreviewItem(slide, true);
          }}
          title="Click to stage the comparison, double-click to put it on screen"
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-0.5 text-[11.5px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
        >
          Stage the comparison
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {looking && columns.length === 0 ? (
          <p className="px-2 py-4 text-center text-[12px] text-pulpitry-muted">
            Looking…
          </p>
        ) : null}

        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`,
          }}
        >
          {columns.map((column) => (
            <section key={column.id} className="min-w-0">
              <p className="mb-1 text-[11px] tracking-wide text-pulpitry-muted uppercase">
                {column.id}
              </p>
              {column.missing ? (
                <p className="text-[12px] leading-relaxed text-pulpitry-muted">
                  This passage is not in {column.id}. Some editions number the
                  verses differently, and a few leave a verse out altogether.
                </p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {column.lines.map((line) => (
                    <li
                      key={line.number}
                      className="text-[12.5px] leading-relaxed text-pulpitry-text"
                    >
                      <sup className="mr-1 align-super text-[9px] text-pulpitry-muted tabular-nums">
                        {line.number}
                      </sup>
                      {line.text}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
