import { componentText, type LiveBody } from "../lib/projector";
import type { SongSection } from "../lib/catalog";
import type { ProjectorTheme } from "../lib/theme";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState, Panel } from "./Panel";
import { SlideCanvas } from "./SlideCanvas";

/** What a section is made of, in the form the canvas draws. */
function bodyOf(section: SongSection): LiveBody {
  return section.components && section.components.length > 0
    ? {
        kind: "composed",
        components: section.components,
        layout: section.layout ?? "stacked",
      }
    : { kind: "lyric", lines: section.lines };
}

/** The words on a slide, however it is made of them. */
function wordsIn(section: SongSection): number {
  const text =
    section.components && section.components.length > 0
      ? section.components.map(componentText).join(" ")
      : section.lines.join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The deck in hand, laid out as slides.
 *
 * A deck was staged and then stepped blind: the operator could see the slide
 * they were on and the one they had queued, and nothing else. Everything
 * between them — how many there are, which one has the notices on it, whether
 * the third slide is the one with the bank details — had to be remembered or
 * found by pressing Next until it appeared, in front of everybody.
 *
 * So the whole deck is on screen, drawn by the real renderer on the church's
 * own look, numbered as an operator counts.
 *
 * # One click stages, two puts it up
 *
 * The same rule as every other list in the window — the chapter, the
 * detections, the queue, the library — and the reason it has to be the same
 * everywhere: an operator learns it once, under pressure, and a panel that
 * broke the rule would put a slide in front of a congregation on a click
 * somebody meant as a look. Staging is always safe here, and that is what
 * makes the double-click worth having.
 *
 * # Word counts
 *
 * Because the commonest fault in a church's own slides is too much on one of
 * them, and the number is the fastest way to see it while there is still time
 * to split the slide.
 */
export function DeckStrip({
  deck,
  liveKey,
  keyOf,
  theme,
  onSelect,
}: {
  /** The staged deck or song, or null when what is staged is neither. */
  deck: Presentable | null;
  /** What is on the projector, so the slide that is up can be marked. */
  liveKey: string | null;
  keyOf: (item: Presentable) => string;
  theme: ProjectorTheme;
  /** Stages that slide. `andShow` sends it in the same gesture. */
  onSelect: (index: number, andShow?: boolean) => void;
}) {
  const sections = deck?.kind === "lyric" ? deck.sections : [];

  return (
    <Panel
      title={deck?.kind === "lyric" ? deck.title : "No deck staged"}
      accent="teal"
      className="min-h-0"
      actions={
        sections.length > 0 ? (
          <span className="text-[11px] text-pulpitry-muted tabular-nums">
            {sections.length} {sections.length === 1 ? "slide" : "slides"}
          </span>
        ) : null
      }
    >
      {deck?.kind !== "lyric" || sections.length === 0 ? (
        <EmptyState>
          Choose a deck below and its slides appear here, ready to step
          through.
        </EmptyState>
      ) : (
        /*
         * One row that scrolls sideways, not a grid.
         *
         * A deck is a sequence and reads as one: slide four is to the right of
         * slide three, at any deck length, and an operator looking for "the one
         * near the end" moves in one direction to find it. A wrapping grid puts
         * it somewhere that depends on the width of the window.
         */
        <div className="flex h-full min-h-0 items-start gap-2 overflow-x-auto p-2">
          {sections.map((section, index) => {
            const at = { ...deck, index };
            const isLive = keyOf(at) === liveKey;
            const isStaged = index === deck.index;
            const words = wordsIn(section);

            return (
              <button
                key={`${section.label}-${index}`}
                type="button"
                onClick={() => onSelect(index)}
                onDoubleClick={() => onSelect(index, true)}
                title={`${section.label || `Slide ${index + 1}`} — ${words} ${
                  words === 1 ? "word" : "words"
                }. Click to stage, double-click to put it on screen.`}
                className={`group flex w-[15rem] shrink-0 flex-col gap-1 rounded border p-1.5 text-left transition-colors focus-visible:focus-ring ${
                  isLive
                    ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                    : isStaged
                      ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim/40"
                      : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                }`}
              >
                <SlideCanvas blocks={[]} body={bodyOf(section)} theme={theme} />

                <span className="flex items-baseline gap-1.5">
                  <span
                    className={`shrink-0 rounded px-1 text-[10.5px] tabular-nums ${
                      isLive
                        ? "bg-pulpitry-gold/20 text-pulpitry-gold"
                        : "bg-pulpitry-raised text-pulpitry-muted"
                    }`}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-pulpitry-text">
                    {section.label || `Slide ${index + 1}`}
                  </span>
                </span>

                <span className="text-[10.5px] text-pulpitry-muted tabular-nums">
                  {words} {words === 1 ? "word" : "words"}
                  {isLive ? " · on screen" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
