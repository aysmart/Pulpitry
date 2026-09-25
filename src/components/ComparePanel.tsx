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
 *
 * Passages are deliberately *not* remembered. A translation is a habit; "John
 * 3:16 beside Mark 10:45" is this morning's sermon, and finding last week's
 * comparison still on screen would be worse than typing it again.
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

interface Column {
  /** What was asked for, which is also what the column is called. */
  reference: string;
  translation: string;
  lines: { number: number; text: string }[];
  /** Asked for and not there: a translation that omits it, or a bad reference. */
  missing: boolean;
  /** The staged passage's own column cannot be taken away. */
  fixed: boolean;
}

/**
 * Scripture beside scripture.
 *
 * # Two comparisons, one pane
 *
 * **The same passage in several translations** -- does this one say servant or
 * slave -- which is checked before it goes up, and asked from the platform.
 *
 * **Different passages beside each other**: John against Mark, a promise
 * against its fulfilment, what one gospel leaves out. That is most of what a
 * preacher means by "compare", and it was the first thing the operator asked
 * for once the translations worked.
 *
 * They are the same shape underneath -- a column is a reference read in a
 * translation -- so the pane does not have two modes to learn. Picking a
 * translation adds the staged passage again in it; typing a reference adds
 * that passage. Both arrive as another column.
 *
 * # Reading and showing are separate
 *
 * The pane reads. Staging it puts it up as a table, because a comparison *is*
 * one and the wall already draws composed tables in the church's own look. How
 * the table is built depends on what is being compared: verse against verse
 * where the columns are one passage in several translations, and passage
 * against passage where they are not -- lining up John 3:16 with Mark 10:45 by
 * verse number would be arithmetic pretending to be meaning.
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
  /** The desk's own translation, which is always the first column. */
  reading: string;
  onPreviewItem: (item: Presentable, andShow?: boolean) => void;
  onError: (message: string) => void;
}) {
  const [versions, setVersions] = useState<string[]>(() => remembered([]));
  const [passages, setPassages] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [adding, setAdding] = useState(false);
  const [columns, setColumns] = useState<Column[]>([]);
  const [looking, setLooking] = useState(false);

  const reference = referenceOf(staged);

  /*
   * What to fetch: the staged passage in the desk's translation, then in each
   * version asked for, then every passage added beside it.
   *
   * The staged one leads and cannot be removed. A comparison that did not
   * include what is on the desk would be comparing two things against neither.
   */
  const wanted = [
    { reference, translation: reading, fixed: true },
    ...versions
      .filter((id) => id !== reading)
      .map((id) => ({ reference, translation: id, fixed: false })),
    ...passages.map((passage) => ({
      reference: passage,
      translation: reading,
      fixed: false,
    })),
  ];
  const asked = JSON.stringify(wanted);

  useEffect(() => {
    if (!reference) {
      setColumns([]);
      return;
    }
    let live = true;
    setLooking(true);
    void Promise.all(
      (JSON.parse(asked) as typeof wanted).map(async (column) => {
        try {
          const passage = await scriptureIn(column.translation, column.reference);
          return {
            ...column,
            // The caption is what the library resolved it to, which is the
            // honest name for a column somebody typed "jn 3 16" into.
            reference: passage.caption || column.reference,
            lines: passage.lines,
            missing: passage.lines.length === 0,
          };
        } catch {
          return { ...column, lines: [], missing: true };
        }
      }),
    )
      .then((found) => live && setColumns(found))
      .catch((err) => live && onError(describeError(err)))
      .finally(() => live && setLooking(false));
    return () => {
      live = false;
    };
    // `asked` is the whole request as text, so this refetches when a column is
    // added, removed or re-read and at no other time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, reference]);

  const toggle = useCallback((id: string) => {
    setVersions((was) => {
      const next = was.includes(id)
        ? was.filter((held) => held !== id)
        : [...was, id];
      remember(next);
      return next;
    });
  }, []);

  /**
   * A passage typed beside the staged one.
   *
   * Looked up before it is added, so a reference nobody can resolve says so in
   * the box rather than becoming a column that reads "not there" for the rest
   * of the service.
   */
  const add = async () => {
    const want = typed.trim();
    if (!want) return;
    setAdding(true);
    try {
      const found = await scriptureIn(reading, want);
      if (found.lines.length === 0) {
        onError(`Nothing at “${want}” in ${reading}.`);
        return;
      }
      setPassages((was) =>
        was.includes(found.caption) ? was : [...was, found.caption],
      );
      setTyped("");
    } catch (err) {
      onError(describeError(err));
    } finally {
      setAdding(false);
    }
  };

  /**
   * The comparison as a slide.
   *
   * Verse against verse where every column is the same passage, because that is
   * what a reader follows across. Passage against passage otherwise, each
   * column its own block of words under its own reference -- lining up two
   * different readings by verse number would be arithmetic pretending to be
   * meaning.
   */
  const asSlide = (): Presentable | null => {
    const shown = columns.filter((column) => !column.missing);
    if (shown.length === 0) return null;

    const first = shown[0]!;
    const sameText = shown.every((column) => column.reference === first.reference);

    const header = sameText
      ? ["", ...shown.map((column) => column.translation)]
      : shown.map((column) => column.reference);

    const rows = sameText
      ? first.lines.map((line) => [
          String(line.number),
          ...shown.map(
            (column) =>
              column.lines.find((other) => other.number === line.number)?.text ??
              "",
          ),
        ])
      : [
          shown.map((column) =>
            column.lines
              .map((line) =>
                column.lines.length > 1 ? `${line.number} ${line.text}` : line.text,
              )
              .join(" "),
          ),
        ];

    return {
      kind: "slide",
      // Ad-hoc, as the lexicon's definitions are: built from what is staged
      // rather than saved in the library, because a comparison is a question
      // asked once.
      itemId: -1,
      title: sameText
        ? first.reference
        : shown.map((column) => column.reference).join("  ·  "),
      blocks: [],
      components: [{ kind: "table", header, rows }],
      layout: "stacked",
    };
  };

  if (!staged || staged.kind !== "scripture") {
    return (
      <EmptyState>
        Stage a verse and it appears here — in any translation you pick, and
        beside any other passage you name.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-pulpitry-line px-2.5 py-2">
        {translations.map((entry) => {
          const on = entry.id === reading || versions.includes(entry.id);
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
                    : `The same passage in ${entry.name}`
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

      {/* A passage beside the staged one: John against Mark, a promise against
          what came of it. Typed the way every other box here takes a
          reference. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
        className="flex shrink-0 gap-1.5 border-b border-pulpitry-line px-2.5 py-2"
      >
        <input
          value={typed}
          spellCheck={false}
          placeholder="Compare with another passage — Mark 10 45"
          onChange={(event) => setTyped(event.target.value)}
          className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1 text-[12px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
        />
        <button
          type="submit"
          disabled={!typed.trim() || adding}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
        >
          Add
        </button>
      </form>

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
          {columns.map((column, index) => (
            <section key={`${column.reference}-${column.translation}-${index}`} className="min-w-0">
              <p className="mb-1 flex items-baseline gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] tracking-wide text-pulpitry-muted uppercase">
                  {column.reference}
                  <span className="ml-1 text-pulpitry-muted/70">
                    {column.translation}
                  </span>
                </span>
                {column.fixed ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      column.reference === reference
                        ? toggle(column.translation)
                        : setPassages((was) =>
                            was.filter((held) => held !== column.reference),
                          )
                    }
                    aria-label={`Stop comparing ${column.reference}`}
                    title="Take this column away"
                    className="shrink-0 rounded px-1 text-[12px] leading-none text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                  >
                    &times;
                  </button>
                )}
              </p>

              {column.missing ? (
                <p className="text-[12px] leading-relaxed text-pulpitry-muted">
                  Not in {column.translation}. Some editions number the verses
                  differently, and a few leave one out altogether.
                </p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {column.lines.map((line) => (
                    <li
                      key={line.number}
                      className="text-[12.5px] leading-relaxed text-pulpitry-text"
                    >
                      {column.lines.length > 1 ? (
                        <sup className="mr-1 align-super text-[9px] text-pulpitry-muted tabular-nums">
                          {line.number}
                        </sup>
                      ) : null}
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
