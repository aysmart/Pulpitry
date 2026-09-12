import type { Presentable } from "../lib/usePresentation";
import { EmptyState, Panel } from "./Panel";

/**
 * The parts of the song that is staged: Verse 1, Chorus, Bridge.
 *
 * # Why a song needs this and a deck does not
 *
 * A deck is run in order, so the slide strip shows it in order and Next is the
 * control that matters. A song is not: the band repeats the chorus twice here
 * and three times at the end, goes back to verse two because the leader said
 * so, and finishes on the bridge. Stepping through a song with Next is
 * therefore pressing it four times to get back to the chorus, in front of
 * everybody, while the congregation is already singing it.
 *
 * So every part is one press, named as the band names it.
 *
 * # One click stages, two puts it up
 *
 * The same rule as every other list in the window. Worth saying twice here,
 * because this is the panel most likely to be used mid-song: a click that went
 * live would put the wrong verse up the first time somebody checked what was
 * in the second one.
 */
export function SectionsPanel({
  song,
  liveKey,
  keyOf,
  onSelect,
}: {
  /** The staged song or deck, or null when what is staged is neither. */
  song: Presentable | null;
  liveKey: string | null;
  keyOf: (item: Presentable) => string;
  onSelect: (index: number, andShow?: boolean) => void;
}) {
  const sections = song?.kind === "lyric" ? song.sections : [];

  return (
    <Panel
      title="Sections"
      accent="teal"
      actions={
        sections.length > 0 ? (
          <span className="truncate text-[11px] text-pulpitry-muted">
            {song?.kind === "lyric" ? song.title : ""}
          </span>
        ) : null
      }
    >
      {song?.kind !== "lyric" || sections.length === 0 ? (
        <EmptyState>
          Choose a song and its parts appear here, each one a press away.
        </EmptyState>
      ) : (
        <ol className="flex flex-col gap-0.5 p-1">
          {sections.map((section, index) => {
            const at = { ...song, index };
            const isLive = keyOf(at) === liveKey;
            const isStaged = index === song.index;
            // The first line, because "Verse 2" is not how anybody remembers
            // which verse it is.
            const opening = section.lines[0] ?? "";

            return (
              <li key={`${section.label}-${index}`}>
                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  onDoubleClick={() => onSelect(index, true)}
                  title="Click to stage, double-click to put it on screen"
                  className={`w-full rounded border px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                    isLive
                      ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                      : isStaged
                        ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim"
                        : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                  }`}
                >
                  <span
                    className={`block text-[11px] tracking-[0.08em] uppercase ${
                      isLive ? "text-pulpitry-gold" : "text-pulpitry-muted"
                    }`}
                  >
                    {section.label || `Part ${index + 1}`}
                    {isLive ? " · on screen" : ""}
                  </span>
                  {opening ? (
                    <span className="mt-0.5 block truncate text-[12px] text-pulpitry-text">
                      {opening}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
