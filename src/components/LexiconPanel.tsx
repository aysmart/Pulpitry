import type { LexiconEntry } from "../lib/bible";
import { EmptyState } from "./Panel";

/**
 * One Strong's entry, given room to be read.
 *
 * It began underneath the interlinear, which was the wrong place twice over: a
 * full lexicon entry is several hundred words and the panel it sat in is a
 * strip of word-cards, so it either overflowed or was clipped. Here it has the
 * width of the library and the operator is taken to it, rather than having to
 * find where the answer appeared.
 *
 * # Two books, named
 *
 * The brief lexicon and Thayer's are different works with different opinions,
 * and showing them as one paragraph would be quietly inventing a third. They
 * are labelled and stacked, brief first — an operator mid-service reads the
 * short one, and the person studying on a Tuesday scrolls.
 *
 * Thayer's covers the Greek New Testament and nothing else, so every Hebrew
 * word and a good many Greek ones have only the brief entry. That is stated
 * where it happens rather than left as an empty space.
 *
 * # Projecting the definitions, a paragraph at a time
 *
 * Every paragraph is its own target, and the section header carries a control
 * for the whole thing. A preacher expounding a word wants one sense of it —
 * "sense 2, the one Paul is using" — and the paragraph is the unit that sense
 * comes in. Sending the whole article is offered too, because sometimes it is
 * short; but it is the second option rather than the only one, so a wall does
 * not receive three hundred words of Abbott-Smith set in six-point type.
 */
export function LexiconPanel({
  entry,
  looking,
  onProject,
  onProjectText,
}: {
  entry: LexiconEntry | null;
  looking: boolean;
  /**
   * Puts the word itself on the wall. `andShow` sends it in the same gesture.
   *
   * The word, how to say it and what it means — never the apparatus. The
   * Strong's number and the part of speech are how the operator knows they
   * have the right entry, and a congregation reading "G:N-F" has been shown
   * our workings rather than the point.
   */
  onProject: (entry: LexiconEntry, andShow?: boolean) => void;
  /** Puts a passage of the entry on the wall, under its own heading. */
  onProjectText: (title: string, body: string, andShow?: boolean) => void;
}) {
  if (looking) return <EmptyState>Looking…</EmptyState>;
  if (!entry) {
    return (
      <EmptyState>
        Press a Strong&rsquo;s number under any word in the Original panel and
        its entry appears here.
      </EmptyState>
    );
  }

  /** "ἀγάπη (agapē)", which is what the wall should say this is about. */
  const heading = entry.transliteration
    ? `${entry.lemma} (${entry.transliteration})`
    : entry.lemma;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[19px] text-pulpitry-text">
          {entry.lemma}{" "}
          <span className="text-[14px] text-pulpitry-teal">
            {entry.transliteration}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-pulpitry-muted tabular-nums">
          {entry.strongs}
          {entry.part ? ` · ${entry.part}` : ""}
        </span>
      </div>

      {entry.gloss ? (
        <span className="text-[14px] text-pulpitry-text">{entry.gloss}</span>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onProject(entry)}
          onDoubleClick={() => onProject(entry, true)}
          title="Click to stage, double-click to put it on screen"
          className="rounded border border-pulpitry-line px-2.5 py-1 text-[12px] text-pulpitry-text hover:bg-pulpitry-raised focus-visible:focus-ring"
        >
          Put the word on screen
        </button>
      </div>

      {entry.definition ? (
        <Book
          name="Brief lexicon"
          heading={heading}
          text={entry.definition}
          onProjectText={onProjectText}
        />
      ) : null}

      <Book
        name="Thayer&rsquo;s"
        heading={heading}
        text={entry.thayer}
        empty={
          entry.strongs.startsWith("H")
            ? "Thayer’s covers the Greek New Testament, so it has no entry for a Hebrew word."
            : "No Thayer’s entry for this number."
        }
        onProjectText={onProjectText}
      />
    </div>
  );
}

/**
 * One of the two lexicons, projectable whole or by the paragraph.
 *
 * The heading sent with a paragraph is the word and how to say it, never the
 * book it came from: a congregation reading a definition needs to know which
 * word is being defined, and "Brief lexicon" tells them nothing they can use.
 */
function Book({
  name,
  heading,
  text,
  empty,
  onProjectText,
}: {
  name: string;
  heading: string;
  text: string;
  /** What to say when this book has nothing for this number. */
  empty?: string;
  onProjectText: (title: string, body: string, andShow?: boolean) => void;
}) {
  // Paragraphs as the build script marked them. Blank ones are dropped rather
  // than staged, because an empty slide is indistinguishable from a fault.
  const paragraphs = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[10.5px] uppercase tracking-[0.14em] text-pulpitry-muted">
          {name}
        </h3>
        {paragraphs.length > 0 ? (
          <button
            type="button"
            onClick={() => onProjectText(heading, paragraphs.join("\n"))}
            onDoubleClick={() =>
              onProjectText(heading, paragraphs.join("\n"), true)
            }
            title="Click to stage the whole entry, double-click to put it on screen"
            className="shrink-0 rounded border border-pulpitry-line px-1.5 py-0.5 text-[10.5px] text-pulpitry-muted hover:bg-pulpitry-raised hover:text-pulpitry-text focus-visible:focus-ring"
          >
            Put all of it on screen
          </button>
        ) : null}
      </div>

      {paragraphs.length === 0 ? (
        <p className="text-[12px] text-pulpitry-muted/70">{empty}</p>
      ) : (
        paragraphs.map((paragraph, at) => (
          /*
           * A paragraph the operator can send on its own.
           *
           * A div with a button role rather than a button: these run to several
           * lines and a button element fights the text layout — and the panel
           * has already been bitten once by a control nested where the browser
           * delivered its clicks somewhere else.
           */
          <div
            key={at}
            role="button"
            tabIndex={0}
            onClick={() => onProjectText(heading, paragraph)}
            onDoubleClick={() => onProjectText(heading, paragraph, true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onProjectText(heading, paragraph);
            }}
            title="Click to stage this paragraph, double-click to put it on screen"
            className="cursor-pointer whitespace-pre-wrap rounded border border-transparent px-1 py-0.5 text-[12.5px] leading-relaxed text-pulpitry-muted transition-colors hover:border-pulpitry-line hover:bg-pulpitry-raised hover:text-pulpitry-text focus-visible:focus-ring"
          >
            {paragraph}
          </div>
        ))
      )}
    </section>
  );
}
