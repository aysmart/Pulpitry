import { useCallback, useEffect, useRef, useState } from "react";

import {
  getChapter,
  listBooks,
  resolveReference,
  searchVerses,
  semanticSearch,
  type Book,
  type Translation,
  type Verse,
} from "../lib/bible";
import { describeError } from "../lib/api";
import { useKeepInView } from "../lib/useKeepInView";
import type { IndexStatus } from "../lib/useSemanticIndex";

/**
 * Finding a verse, three ways.
 *
 * **Words** is one input doing two jobs: text that parses as a reference
 * ("Luke 3", "Jere 32 11", "1 cor 13:4") navigates there, and anything else
 * falls back to full-text search. That much saves the operator from choosing a
 * mode for the commonest thing they do. A reference with a verse in it is
 * staged as it is found, so the whole act is: type what was announced, press
 * Enter, press Display.
 *
 * **Meaning** is the third way and it cannot be folded into the other two,
 * because it answers a different question. "The one about the widow's offering"
 * shares no words with Mark 12:42 and a text search on it returns nothing —
 * while the embedding index that paraphrase matching builds finds it at once.
 * That index has been in the app since paraphrase matching shipped and only
 * speech could reach it: an operator who remembered a passage without
 * remembering its wording had no way in at all.
 *
 * It is a deliberate mode rather than a fallback after a failed text search,
 * because the two disagree about what an empty result means. A word search
 * finding nothing is usually a typo; a meaning search finding nothing is a
 * real answer.
 */
export function ChapterNavigator({
  translation,
  translations,
  onSelectTranslation,
  onPreview,
  onPreviewRange,
  previewVerseIds,
  liveVerseIds,
  index,
  follow,
}: {
  translation: string;
  translations: Translation[];
  onSelectTranslation: (id: string) => void;
  onPreview: (verse: Verse, andShow?: boolean) => void;
  onPreviewRange: (verses: Verse[], andShow?: boolean) => void;
  previewVerseIds: number[];
  liveVerseIds: number[];
  /**
   * The embedding index, which meaning search reads.
   *
   * Passed in rather than subscribed to here: the desk already watches it for
   * the status line, and a second listener would be a second copy of the same
   * truth.
   */
  index: IndexStatus;
  /**
   * The verse to bring into view, or null.
   *
   * Whatever is staged: a detection the operator clicked, an entry taken from
   * the running order, or the verse Prev and Next just moved to. The panel
   * follows it — book, chapter, and the verse itself scrolled to and lit.
   *
   * Why it matters beyond tidiness: the Original panel shows the Greek or
   * Hebrew for whatever is staged, so an operator who wants a word from a
   * detected verse needs the chapter list on that verse too. Before this they
   * had to find it by hand while the sentence they were following moved on.
   */
  follow: Verse | null;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [bookNumber, setBookNumber] = useState(1);
  const [chapter, setChapter] = useState(1);
  const [verses, setVerses] = useState<Verse[]>([]);
  const [results, setResults] = useState<Verse[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focusVerse, setFocusVerse] = useState<number | null>(null);
  /** Which question the input is asking. */
  const [mode, setMode] = useState<"words" | "meaning">("words");
  const [searching, setSearching] = useState(false);
  /*
   * How close each meaning match came, by verse id.
   *
   * Kept beside the results rather than in them so a word search and a meaning
   * search can share one list and one renderer. Empty for a word search, which
   * is the honest answer there: a text match either contains the words or it
   * does not, and a number against it would be invented.
   */
  const [scores, setScores] = useState<Map<number, number>>(new Map());

  /*
   * The translation being read, which is not always the one being detected in.
   *
   * Detection searches `settings.translation` and nothing else -- changing it
   * also clears the suppression list -- so a panel that switched it every time
   * somebody clicked a cross-translation detection would quietly retarget
   * detection mid-sermon. Click one Yoruba match during an English service and
   * the English stops being found.
   *
   * So following a staged verse changes only what is *shown*. The operator's
   * working translation changes when the operator changes it, from the picker
   * below, and never as a side effect of clicking a verse.
   */
  const [viewing, setViewing] = useState(translation);
  useEffect(() => setViewing(translation), [translation]);

  const listRef = useRef<HTMLDivElement>(null);
  // Where a shift-click measures from.
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    if (!viewing) return;
    let active = true;
    void listBooks(viewing)
      .then((loaded) => {
        if (!active) return;
        setBooks(loaded);
        setError(null);
      })
      .catch((err) => active && setError(describeError(err)));
    return () => {
      active = false;
    };
  }, [viewing]);

  useEffect(() => {
    if (!viewing || books.length === 0) return;
    let active = true;
    void getChapter(viewing, bookNumber, chapter)
      .then((loaded) => {
        if (!active) return;
        setVerses(loaded);
        setError(null);
      })
      .catch((err) => active && setError(describeError(err)));
    return () => {
      active = false;
    };
  }, [viewing, bookNumber, chapter, books.length]);

  /*
   * Follow what is staged — but only when it changes.
   *
   * Keyed on the verse id, so an operator who deliberately browses to Romans
   * while John 3:16 is live is left where they went. Only a *new* verse being
   * staged moves the panel; without that this would yank the chapter list back
   * every time it rendered, which is a worse panel than one that never follows
   * at all.
   *
   * Results are cleared because a search list is showing instead of the
   * chapter, and navigating underneath it would happen where nobody can see it.
   */
  const followedId = follow?.id ?? null;
  useEffect(() => {
    if (!follow) return;
    // Including the translation: the point is to show what is on the wall, and
    // the same reference reads differently in another version.
    if (follow.translation) setViewing(follow.translation);
    setBookNumber(follow.bookNumber);
    setChapter(follow.chapter);
    setResults(null);
    // Scores belong to a search that is no longer on screen; a chapter listing
    // would otherwise carry one against whichever verse happened to match.
    setScores(new Map());
    setFocusVerse(follow.verse);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followedId]);

  // Bring a referenced verse into view once its chapter has rendered.
  useEffect(() => {
    if (focusVerse === null || results) return;

    /*
     * Wait for the chapter that actually contains it.
     *
     * `verses` lags the pickers by a fetch, so for one render it still holds
     * the chapter being left. Verse 16 exists in most chapters, so without this
     * the panel scrolls to the wrong verse 16, clears the request, and is then
     * sitting still when the right chapter arrives — which looks exactly like
     * the feature not working.
     */
    const here = verses[0];
    if (!here || here.bookNumber !== bookNumber || here.chapter !== chapter)
      return;

    const target = listRef.current?.querySelector(
      `[data-verse="${focusVerse}"]`,
    );
    target?.scrollIntoView({ block: "center" });
    setFocusVerse(null);
  }, [focusVerse, verses, results, bookNumber, chapter]);

  const currentBook = books.find((book) => book.number === bookNumber);

  const submit = useCallback(
    async (event: React.FormEvent, andShow = false) => {
      event.preventDefault();
      const text = query.trim();
      if (!text) {
        setResults(null);
        setScores(new Map());
        return;
      }
      setError(null);

      /*
       * A search by meaning, which never navigates.
       *
       * No reference parsing first: an operator in this mode who types "John
       * 3:16" wants verses *like* it, and silently jumping to the chapter
       * instead would be the app overriding a mode they chose on purpose.
       */
      if (mode === "meaning") {
        setSearching(true);
        try {
          const found = await semanticSearch(text);
          setResults(found.map((hit) => hit.verse));
          setScores(new Map(found.map((hit) => [hit.verse.id, hit.score])));
        } catch (err) {
          setError(describeError(err));
        } finally {
          setSearching(false);
        }
        return;
      }

      setScores(new Map());
      try {
        const reference = await resolveReference(viewing, text);
        if (reference) {
          setResults(null);
          setBookNumber(reference.bookNumber);
          setChapter(reference.chapter);
          if (reference.verse !== null) {
            setFocusVerse(reference.verse);
            const chapterVerses = await getChapter(
              viewing,
              reference.bookNumber,
              reference.chapter,
            );
            // "John 3:16-18" stages the whole passage, not just where it starts.
            const last = reference.endVerse ?? reference.verse;
            const passage = chapterVerses.filter(
              (item) => item.verse >= reference.verse! && item.verse <= last,
            );
            if (passage.length > 1) onPreviewRange(passage, andShow);
            else if (passage[0]) onPreview(passage[0], andShow);
          }
          return;
        }
        setResults(await searchVerses(viewing, text));
      } catch (err) {
        setError(describeError(err));
      }
    },
    [query, viewing, mode, onPreview, onPreviewRange],
  );

  const rows = results ?? verses;

  /*
   * The verse on the wall, and the one staged, kept in view as they move.
   *
   * Next verse, a voice command and a detection all move them from outside
   * this list. Keyed on the first row as well, so a step into the next chapter
   * scrolls once that chapter's rows exist rather than before.
   */
  const shown = rows[0]?.id ?? "";
  useKeepInView(listRef, "live", liveVerseIds.length ? `${liveVerseIds.join(",")}@${shown}` : null);
  useKeepInView(listRef, "preview", previewVerseIds.length ? `${previewVerseIds.join(",")}@${shown}` : null);

  /*
   * Shift and an arrow adds the verse above or below to what is staged.
   *
   * Shift-click has always extended a passage; there was no way to do it from
   * the keyboard, and an operator asked for one. The same modifier, because it
   * is the same act -- and Control as well, where the system leaves it alone:
   * they asked for Control, and on macOS Control with the arrows is Mission
   * Control's, which is not an argument this application can win.
   *
   * It moves the end that moved last and leaves the other where it is, so
   * pressing back the other way gives the verse up again rather than jumping
   * the passage somewhere new. Where the staged passage is not in this list --
   * a different chapter, a search away -- the keys keep their own meaning.
   */
  const reach = useRef<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!event.shiftKey && !event.ctrlKey) return;
      if (event.metaKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable ||
        document.querySelector("[data-dialog]")
      )
        return;

      const source = results ?? verses;
      const staged = source
        .map((verse, index) => (previewVerseIds.includes(verse.id) ? index : -1))
        .filter((index) => index >= 0);
      if (staged.length === 0) return;

      event.preventDefault();
      const first = staged[0]!;
      const last = staged[staged.length - 1]!;

      /*
       * The anchor is whichever end the operator did not move last. Taken from
       * the passage itself rather than trusted from a click that may have been
       * chapters ago: a detection can stage something else entirely between
       * one press and the next.
       */
      const held = anchor.current === last ? last : first;
      const moving = held === first ? last : first;
      anchor.current = held;

      const wanted = (reach.current === first || reach.current === last ? reach.current : moving) +
        (event.key === "ArrowDown" ? 1 : -1);
      const landed = Math.min(Math.max(wanted, 0), source.length - 1);
      reach.current = landed;

      const from = Math.min(held, landed);
      const to = Math.max(held, landed);
      onPreviewRange(source.slice(from, to + 1));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [results, verses, previewVerseIds, onPreviewRange]);

  /**
   * Plain click stages one verse; shift-click extends from the last plain
   * click to here, which is how a preacher reads a passage rather than a line.
   */
  const choose = (verse: Verse, extend: boolean) => {
    const source = results ?? verses;
    const index = source.findIndex((candidate) => candidate.id === verse.id);

    if (extend && anchor.current !== null && index >= 0) {
      const from = Math.min(anchor.current, index);
      const to = Math.max(anchor.current, index);
      onPreviewRange(source.slice(from, to + 1));
      return;
    }

    anchor.current = index >= 0 ? index : null;
    reach.current = anchor.current;
    onPreview(verse);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-pulpitry-line px-2.5 py-2">
        {/*
          Which question the input is asking, said before it is asked.

          Above the field rather than beside it: the two searches take different
          text -- a reference or a description -- and an operator needs to know
          which one they are typing into before they start typing.
        */}
        <div className="flex items-center gap-1.5">
          <div
            role="group"
            aria-label="How to search"
            className="flex items-center gap-0.5 rounded border border-pulpitry-line bg-pulpitry-raised p-0.5"
          >
            {(
              [
                [
                  "words",
                  "Words",
                  "A reference or the words themselves: Jere 32 11, Luke 3, John 3:16-18, or “in the beginning”",
                ],
                [
                  "meaning",
                  "Meaning",
                  "Describe the passage in your own words and find the verses nearest to it",
                ],
              ] as const
            ).map(([id, label, hint]) => (
              <button
                key={id}
                type="button"
                title={hint}
                aria-pressed={mode === id}
                onClick={() => {
                  setMode(id);
                  // The list belongs to the question that produced it. Leaving
                  // meaning matches on screen under a word search would be two
                  // different claims in one list.
                  setResults(null);
                  setScores(new Map());
                  setError(null);
                }}
                className={`rounded px-2 py-1 text-[11.5px] transition-colors focus-visible:focus-ring ${
                  mode === id
                    ? "bg-pulpitry-teal-dim text-pulpitry-text"
                    : "text-pulpitry-muted hover:text-pulpitry-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="flex-1" />

          <select
            value={viewing}
            onChange={(event) => {
              // A deliberate pick is both: it is what to read and what to
              // detect in. Only following a staged verse is view-only.
              setViewing(event.target.value);
              onSelectTranslation(event.target.value);
            }}
            aria-label="Translation"
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring"
          >
            {translations.map((entry) => (
              <option
                key={entry.id}
                value={entry.id}
                title={`${entry.name} (${entry.year})`}
              >
                {entry.id}
              </option>
            ))}
          </select>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          data-tour="bible"
          className="mt-1.5 flex gap-1.5"
        >
          <input
            value={query}
            spellCheck={false}
            /*
              Enter here stages, so Enter twice puts it up -- the same rule as
              a double-click on a row. Marked rather than assumed, because
              every other box on these desks takes Return without meaning
              anything by it: a service being renamed, a song being looked for.
              See the Enter handler in App.
            */
            data-search
            data-stages
            /*
              Enter stages what was typed; the same press with the command or
              control key puts it up. A reading is announced and the desk has
              four seconds: this is that, in one press rather than three.
            */
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
                return;
              void submit(event, true);
            }}
            /* The terse form first, because it is the one worth knowing: an
               operator with a reading announced and four seconds types it the
               way it was said. The colon still works and always did. */
            placeholder={
              mode === "words"
                ? "Jere 32 11, John 3:16-18, or search…"
                : "The one about the widow's offering…"
            }
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value.trim()) {
                setResults(null);
                setScores(new Map());
              }
            }}
            className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
          />
          {/* A visible way to run it, which the Enter key alone was not:
              somebody describing a passage in a sentence has no reason to
              expect a keystroke to be the only way to ask. */}
          <button
            type="submit"
            disabled={
              !query.trim() ||
              searching ||
              (mode === "meaning" && index.state !== "ready")
            }
            className="shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-teal disabled:opacity-40 focus-visible:focus-ring"
          >
            {searching ? "…" : "Find"}
          </button>
        </form>

        {/* Why the Meaning button cannot answer, when it cannot. The index is
            paraphrase matching's, so a church that has it switched off has
            nothing to search -- said here, with the fix in it. */}
        {mode === "meaning" && index.state !== "ready" ? (
          <p className="mt-1.5 text-[11.5px] leading-snug text-pulpitry-muted">
            {index.state === "building"
              ? `Preparing ${index.translation || "the verse index"}${
                  index.total > 0
                    ? ` — ${Math.floor((index.done / index.total) * 100)}%`
                    : "…"
                }. Searching by meaning works as soon as it finishes.`
              : index.state === "error"
                ? (index.error ??
                  "The verse index could not be built, so meaning search is unavailable.")
                : "Searching by meaning reads the index paraphrase matching builds. Turn that on in Settings and it is built once, then kept."}
          </p>
        ) : null}

        <div className="mt-1.5 flex gap-1.5">
          <select
            value={bookNumber}
            aria-label="Book"
            onChange={(event) => {
              setBookNumber(Number(event.target.value));
              setChapter(1);
              setResults(null);
              setScores(new Map());
            }}
            className="min-w-0 flex-1 truncate rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring"
          >
            {books.map((book) => (
              <option key={book.number} value={book.number}>
                {book.name}
              </option>
            ))}
          </select>
          <select
            value={chapter}
            aria-label="Chapter"
            onChange={(event) => {
              setChapter(Number(event.target.value));
              setResults(null);
              setScores(new Map());
            }}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring"
          >
            {Array.from(
              { length: currentBook?.chapters ?? 1 },
              (_, index) => index + 1,
            ).map((number) => (
              <option key={number} value={number}>
                {number}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p className="px-3 py-2 text-[12px] text-pulpitry-gold">{error}</p>
      ) : null}

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {results && results.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] leading-relaxed text-pulpitry-muted">
            {mode === "meaning"
              ? `Nothing in ${index.translation} came close to “${query}”. Try describing it a different way.`
              : `Nothing found for “${query}”.`}
          </p>
        ) : null}

        {rows.map((verse) => {
          const isPreview = previewVerseIds.includes(verse.id);
          const isLive = liveVerseIds.includes(verse.id);
          const score = scores.get(verse.id);
          return (
            <button
              key={verse.id}
              type="button"
              data-verse={verse.verse}
              data-live={isLive}
              data-preview={isPreview}
              onClick={(event) => choose(verse, event.shiftKey)}
              onDoubleClick={() => onPreview(verse, true)}
              className={`flex w-full gap-2 rounded px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                isLive
                  ? "bg-pulpitry-gold/12 text-pulpitry-text"
                  : isPreview
                    ? "bg-pulpitry-teal-dim text-pulpitry-text"
                    : "text-pulpitry-text hover:bg-pulpitry-raised"
              }`}
            >
              <span
                className={`shrink-0 pt-[1px] text-[11px] tabular-nums ${
                  isLive ? "text-pulpitry-gold" : "text-pulpitry-muted"
                }`}
              >
                {results
                  ? `${verse.book} ${verse.chapter}:${verse.verse}`
                  : verse.verse}
              </span>
              <span className="min-w-0 flex-1 text-[12.5px] leading-snug">
                {verse.text}
              </span>
              {/* How close it came, on meaning matches only. A word search has
                  no number to report that would not be invented, and a
                  congregation never sees this -- it is the operator deciding
                  whether to trust a match that shares no words with what they
                  typed. */}
              {score !== undefined ? (
                <span
                  title={`${Math.round(score * 100)}% match by meaning`}
                  className="shrink-0 pt-[1px] text-[10.5px] text-pulpitry-teal tabular-nums"
                >
                  {Math.round(score * 100)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
