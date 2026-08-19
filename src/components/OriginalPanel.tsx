import { useEffect, useState } from "react";

import { originalWords, type OriginalWord, type Verse } from "../lib/bible";
import { EmptyState } from "./Panel";

/**
 * The Greek or Hebrew behind whatever is staged.
 *
 * # One word at a time, never the apparatus
 *
 * A word can go on the wall, because a preacher expounding ἀγάπη is a preacher
 * whose congregation benefits from seeing it. What does not go on the wall is
 * the morphology code and the Strong's number: those are the operator's tools
 * for knowing they have the right word, and projecting them is a distraction
 * wearing the clothes of scholarship.
 *
 * So the card shows five things and stages three — the original, how to say it,
 * and what it means. Clicking stages; double-clicking sends, the same gesture
 * as everywhere else in the desk.
 *
 * # Why the whole verse rather than a lookup
 *
 * The obvious build is a search box: type a word, get its entry. That is what a
 * lexicon is, and it is the wrong shape for a live service — an operator has
 * four seconds and does not know which word they want until they see the verse.
 * Showing every word of what is already staged costs one query and answers the
 * question before it has been asked.
 *
 * # What each word carries
 *
 * The original, how to say it, what it means here, its dictionary form, and its
 * grammar. Hebrew keeps the `/` marking where its prefixes and suffixes join —
 * "in/ beginning" is how the language actually works, and flattening it would
 * discard the thing an interlinear exists to show.
 */
export function OriginalPanel({
  verse,
  onStage,
}: {
  verse: Verse | null;
  /**
   * Stages one word as a slide. `andShow` sends it in the same gesture.
   *
   * A slide rather than a kind of its own: the projector already knows how to
   * draw text blocks, and an original-language word is three lines of text. A
   * new body kind would mean teaching the projector, the mirror and the second
   * display about something they can already render.
   */
  onStage: (word: OriginalWord, reference: string, andShow?: boolean) => void;
}) {
  const [words, setWords] = useState<OriginalWord[]>([]);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    if (!verse) {
      setWords([]);
      return;
    }

    let live = true;
    setLooking(true);
    void originalWords(verse.bookNumber, verse.chapter, verse.verse)
      .then((found) => live && setWords(found))
      // A reference panel that cannot answer says nothing. It is not worth an
      // error in front of somebody running a service.
      .catch(() => live && setWords([]))
      .finally(() => live && setLooking(false));

    return () => {
      live = false;
    };
  }, [verse]);

  if (!verse) {
    return <EmptyState>Stage a verse and its Greek or Hebrew appears here.</EmptyState>;
  }
  if (looking && words.length === 0) {
    return <EmptyState>Looking…</EmptyState>;
  }
  if (words.length === 0) {
    return (
      <EmptyState>
        No original text for {verse.book} {verse.chapter}:{verse.verse}. Versification differs
        between traditions, so a few verses have none.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5 p-2">
      {words.map((word, at) => (
        <button
          key={`${word.strongs}-${at}`}
          type="button"
          onClick={() => onStage(word, `${verse.book} ${verse.chapter}:${verse.verse}`)}
          onDoubleClick={() => onStage(word, `${verse.book} ${verse.chapter}:${verse.verse}`, true)}
          title="Click to stage this word, double-click to put it on screen"
          className="flex min-w-[86px] flex-col gap-0.5 rounded border border-pulpitry-line px-2 py-1.5 text-left transition-colors hover:border-pulpitry-teal/40 hover:bg-pulpitry-raised focus-visible:focus-ring"
        >
          {/* The original is the largest thing in the card, because it is what
              somebody opened this to read. */}
          <span className="text-[15px] leading-tight text-pulpitry-text">{word.original}</span>
          {word.transliteration ? (
            <span className="text-[11px] leading-tight text-pulpitry-teal">
              {word.transliteration}
            </span>
          ) : null}
          {word.gloss ? (
            <span className="text-[11.5px] leading-snug text-pulpitry-muted">{word.gloss}</span>
          ) : null}
          <span className="flex flex-wrap items-baseline gap-1.5 pt-0.5">
            {word.strongs ? (
              <span className="text-[10px] tracking-wide text-pulpitry-muted tabular-nums">
                {word.strongs}
              </span>
            ) : null}
            {word.morphology ? (
              <span className="text-[10px] text-pulpitry-muted/70">{word.morphology}</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}
