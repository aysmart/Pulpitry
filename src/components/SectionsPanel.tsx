import {
  LINE_CHOICES,
  storedLines,
  type LinesPerScreen,
} from "../lib/lyrics";
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
  onLinesChange,
}: {
  /** The staged song or deck, or null when what is staged is neither. */
  song: Presentable | null;
  liveKey: string | null;
  keyOf: (item: Presentable) => string;
  onSelect: (index: number, andShow?: boolean) => void;
  /** Re-splits what is staged. See lib/lyrics.ts. */
  onLinesChange: (lines: LinesPerScreen) => void;
}) {
  /*
   * A song, and not a deck that shares its shape. A deck's slides belong to
   * the slide desk's strip, where they are drawn; listing them here as words
   * would be the same mistake in the other direction.
   */
  const isSong = song?.kind === "lyric" && song.source === "song";
  const sections = isSong ? song.sections : [];

  return (
    <Panel
      tour="song-parts"
      title="Sections"
      accent="teal"
      actions={
        /*
          How many lines a screen holds, where the operator can see the result.

          Here rather than only in Settings because it is judged by looking: the
          room, the screen and the song decide it, and the answer is obvious the
          moment the list below re-breaks. It applies to every song, not this
          one -- it is a fact about the room.
        */
        <select
          value={storedLines()}
          aria-label="Lines on a screen"
          onChange={(event) =>
            onLinesChange(Number(event.target.value) as LinesPerScreen)
          }
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-0.5 text-[11px] text-pulpitry-text outline-none focus-visible:focus-ring"
        >
          {LINE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      }
    >
      {!isSong || song?.kind !== "lyric" || sections.length === 0 ? (
        <EmptyState>
          Choose a song and its parts appear here, each one a press away.
        </EmptyState>
      ) : (
        <ol className="flex flex-col gap-0.5 p-1">
          {sections.map((section, index) => {
            const at = { ...song, index };
            const isLive = keyOf(at) === liveKey;
            const isStaged = index === song.index;
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
                  {/*
                    The words themselves, every line of the screenful.

                    Not a title and not a thumbnail: what the operator is
                    choosing between is what the congregation will read, and two
                    verses of the same song have the same name and different
                    words. Wrapped rather than truncated, because the line that
                    gets cut off is the one that would have told them which
                    screen this is.
                  */}
                  {section.lines.length > 0 ? (
                    <span
                      className={`mt-0.5 block text-[12px] leading-snug ${
                        isStaged || isLive
                          ? "text-pulpitry-text"
                          : "text-pulpitry-muted"
                      }`}
                    >
                      {section.lines.map((line, at) => (
                        <span key={at} className="block truncate">
                          {line}
                        </span>
                      ))}
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
