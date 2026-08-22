import { useCallback, useEffect, useRef, useState } from "react";

import {
  getChapter,
  listBooks,
  resolveReference,
  searchVerses,
  type Book,
  type Translation,
  type Verse,
} from "../lib/bible";
import { describeError } from "../lib/api";

/**
 * Chapter Navigator.
 *
 * One input handles both jobs: if the text parses as a reference ("Luke 3",
 * "1 cor 13:4") it navigates there, and if it does not it falls back to
 * full-text search. That saves the operator from choosing a mode mid-service.
 */
export function ChapterNavigator({
  translation,
  translations,
  onSelectTranslation,
  onPreview,
  onPreviewRange,
  previewVerseIds,
  liveVerseIds,
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
    async (event: React.FormEvent) => {
      event.preventDefault();
      const text = query.trim();
      if (!text) {
        setResults(null);
        return;
      }
      setError(null);
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
            if (passage.length > 1) onPreviewRange(passage);
            else if (passage[0]) onPreview(passage[0]);
          }
          return;
        }
        setResults(await searchVerses(viewing, text));
      } catch (err) {
        setError(describeError(err));
      }
    },
    [query, viewing, onPreview, onPreviewRange],
  );

  const rows = results ?? verses;

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
    onPreview(verse);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-pulpitry-line px-2.5 py-2">
        <form onSubmit={submit} className="flex gap-1.5">
          <input
            value={query}
            spellCheck={false}
            placeholder="Luke 3, John 3:16-18, or search…"
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value.trim()) setResults(null);
            }}
            className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
          />
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
        </form>

        <div className="mt-1.5 flex gap-1.5">
          <select
            value={bookNumber}
            aria-label="Book"
            onChange={(event) => {
              setBookNumber(Number(event.target.value));
              setChapter(1);
              setResults(null);
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
          <p className="px-2 py-6 text-center text-[12.5px] text-pulpitry-muted">
            Nothing found for “{query}”.
          </p>
        ) : null}

        {rows.map((verse) => {
          const isPreview = previewVerseIds.includes(verse.id);
          const isLive = liveVerseIds.includes(verse.id);
          return (
            <button
              key={verse.id}
              type="button"
              data-verse={verse.verse}
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
              <span className="text-[12.5px] leading-snug">{verse.text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
