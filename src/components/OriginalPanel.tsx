import { useEffect, useState } from "react";

import {
  originalWords,
  type LexiconEntry,
  type OriginalWord,
  type Verse,
} from "../lib/bible";
import { LexiconPanel } from "./LexiconPanel";
import { EmptyState, Panel } from "./Panel";

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
 *
 * # The entry is a tab here, not in the library
 *
 * It began as an eighth tab on the library, which put the question and the
 * answer in two different panels: the operator pressed a number on the right of
 * the screen and the reply appeared on the left, under a tab they had to be
 * watching to notice. A Strong's entry belongs to the word it explains, so it
 * lives beside it — and pressing the number switches to it.
 */
export function OriginalPanel({
  verse,
  onStage,
  onOpenLexicon,
  lexicon,
  lexiconLooking,
  lexiconAt,
  onProjectLexicon,
  onProjectLexiconText,
}: {
  verse: Verse | null;
  /** Raises a word's entry. The Lexicon tab beside this one shows it. */
  onOpenLexicon: (strongs: string) => void;
  lexicon: LexiconEntry | null;
  lexiconLooking: boolean;
  /** When the last lookup was asked for. Changes on every press, including
   *  the same word twice, so the tab switch happens every time rather than
   *  only when the entry differs. */
  lexiconAt: number;
  onProjectLexicon: (entry: LexiconEntry, andShow?: boolean) => void;
  /** Puts a passage of an entry on the wall, under the word it defines. */
  onProjectLexiconText: (
    title: string,
    body: string,
    andShow?: boolean,
  ) => void;
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
  const [tab, setTab] = useState<"Words" | "Lexicon">("Words");

  // Pressing a number brings the operator to the answer. The alternative is
  // leaving them to notice that the tab beside them has filled, which during a
  // service they will not.
  useEffect(() => {
    if (lexiconAt > 0) setTab("Lexicon");
  }, [lexiconAt]);

  useEffect(() => {
    if (!verse) {
      setWords([]);
      return;
    }

    let live = true;
    setLooking(true);
    void originalWords(verse.book, verse.chapter, verse.verse)
      .then((found) => live && setWords(found))
      // A reference panel that cannot answer says nothing. It is not worth an
      // error in front of somebody running a service.
      .catch(() => live && setWords([]))
      .finally(() => live && setLooking(false));

    return () => {
      live = false;
    };
  }, [verse]);

  /*
   * The words, or why there are none. Built rather than returned early,
   * because the panel keeps its tab strip whichever of these applies -- an
   * operator who has read an entry must be able to get back to the words even
   * when the verse they moved to has none.
   */
  const wordsBody = !verse ? (
    <EmptyState>Stage a verse and its Greek or Hebrew appears here.</EmptyState>
  ) : looking && words.length === 0 ? (
    <EmptyState>Looking…</EmptyState>
  ) : words.length === 0 ? (
    <EmptyState>
      No original text for {verse.book} {verse.chapter}:{verse.verse}.
      Versification differs between traditions, so a few verses have none.
    </EmptyState>
  ) : (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-wrap gap-1.5">
        {words.map((word, at) => (
          /*
           * A div rather than a button, and the card carries two actions.
           *
           * The Strong's number inside it opens the lexicon while the card itself
           * stages the word -- and a button inside a button is invalid HTML whose
           * inner clicks browsers deliver inconsistently. This was the bug:
           * pressing the number did nothing at all.
           */
          <div
            key={`${word.strongs}-${at}`}
            role="button"
            tabIndex={0}
            onClick={() =>
              onStage(word, `${verse.book} ${verse.chapter}:${verse.verse}`)
            }
            onDoubleClick={() =>
              onStage(
                word,
                `${verse.book} ${verse.chapter}:${verse.verse}`,
                true,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onStage(word, `${verse.book} ${verse.chapter}:${verse.verse}`);
              }
            }}
            title="Click to stage this word, double-click to put it on screen"
            className="flex min-w-[86px] cursor-pointer flex-col gap-0.5 rounded border border-pulpitry-line px-2 py-1.5 text-left transition-colors hover:border-pulpitry-teal/40 hover:bg-pulpitry-raised focus-visible:focus-ring"
          >
            {/* The original is the largest thing in the card, because it is what
              somebody opened this to read. */}
            <span className="text-[15px] leading-tight text-pulpitry-text">
              {word.original}
            </span>
            {word.transliteration ? (
              <span className="text-[11px] leading-tight text-pulpitry-teal">
                {word.transliteration}
              </span>
            ) : null}
            {word.gloss ? (
              <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                {word.gloss}
              </span>
            ) : null}
            <span className="flex flex-wrap items-baseline gap-1.5 pt-0.5">
              {word.strongs ? (
                <span
                  role="button"
                  tabIndex={0}
                  title="What this word means"
                  onClick={(event) => {
                    // The card stages; the number explains. Two jobs on one card,
                    // so the inner one must not also stage what it explains.
                    event.stopPropagation();
                    onOpenLexicon(word.strongs);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenLexicon(word.strongs);
                    }
                  }}
                  className="cursor-pointer rounded-sm px-0.5 text-[10px] tracking-wide text-pulpitry-muted tabular-nums underline-offset-2 hover:text-pulpitry-teal hover:underline focus-visible:focus-ring"
                >
                  {word.strongs}
                </span>
              ) : null}
              {word.morphology ? (
                <span className="text-[10px] text-pulpitry-muted/70">
                  {word.morphology}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Panel
      tour="original"
      title="Original"
      bodyClassName={tab === "Lexicon" ? "" : "overflow-auto"}
      actions={
        <div className="flex gap-0">
          {(["Words", "Lexicon"] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setTab(name)}
              className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors focus-visible:focus-ring ${
                tab === name
                  ? "bg-pulpitry-teal-dim text-pulpitry-text"
                  : "text-pulpitry-muted hover:text-pulpitry-text"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      }
    >
      {tab === "Words" ? (
        wordsBody
      ) : (
        <LexiconPanel
          entry={lexicon}
          looking={lexiconLooking}
          onProject={onProjectLexicon}
          onProjectText={onProjectLexiconText}
        />
      )}
    </Panel>
  );
}
