import { useCallback, useEffect, useState } from "react";

import { describeError } from "../lib/api";
import {
  RIGHTS_LABEL,
  songbookSearch,
  type SongbookHit,
} from "../lib/songbook";
import { EmptyState, Panel } from "./Panel";

/**
 * Searching the catalogue that comes with a subscription.
 *
 * # Why this pane exists
 *
 * A church's first Sunday with new software is the one that decides whether
 * they keep it: the library is empty, the service is at ten, and typing four
 * songs out by hand at nine is how presentation software gets abandoned. Every
 * other way in — EasyWorship, ProPresenter, OpenLP, a pasted text file —
 * assumes they are already running something. This is for the ones who are not.
 *
 * # What it is careful about
 *
 * It never puts words on a wall by itself. A result is looked at first, in the
 * pane beside this one, with what is known about its rights showing — including
 * "unchecked", which is the honest answer for a great many songs and is stated
 * rather than hidden. Adding one is a separate press.
 *
 * # The gate
 *
 * Said once, plainly, in the place it applies, and not as a wall over the
 * search box: everything else in Pulpitry is free and on the machine, and this
 * is a catalogue somebody assembles and hosts. An operator without a
 * subscription should be able to read what it is without being sold to.
 */
export function SongbookPanel({
  subscribed,
  chosen,
  onChoose,
}: {
  /** Whether this machine is activated. The real gate is the broker's. */
  subscribed: boolean;
  /** The id being previewed, so the list can mark it. */
  chosen: string | null;
  onChoose: (hit: SongbookHit) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SongbookHit[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const look = useCallback(async (text: string) => {
    const asked = text.trim();
    if (!asked) {
      setHits(null);
      setError(null);
      return;
    }
    setLooking(true);
    setError(null);
    try {
      setHits(await songbookSearch(asked));
    } catch (err) {
      setError(describeError(err));
      setHits(null);
    } finally {
      setLooking(false);
    }
  }, []);

  /*
   * A pause, not a keystroke.
   *
   * Each search is a request to the broker, and searching on every letter of
   * "great is thy faithfulness" would be twenty-eight of them for one song.
   * Three hundred milliseconds is long enough to finish a word and short
   * enough that nobody presses Enter wondering whether it is broken.
   */
  useEffect(() => {
    if (!subscribed) return;
    const asked = query.trim();
    if (!asked) {
      setHits(null);
      return;
    }
    const timer = setTimeout(() => void look(asked), 300);
    return () => clearTimeout(timer);
  }, [query, subscribed, look]);

  return (
    <Panel
      title="Songbook"
      accent="teal"
      actions={
        hits && hits.length > 0 ? (
          <span className="text-[11px] text-pulpitry-muted tabular-nums">
            {hits.length}
          </span>
        ) : null
      }
    >
      {!subscribed ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="max-w-[34ch] text-[13px] leading-relaxed text-pulpitry-muted">
            The Songbook is a catalogue of songs — the words, who wrote them,
            and what is known about the rights — that comes with a Castavox
            subscription. Search it, look at a song, and add it to your library.
          </p>
          <p className="max-w-[34ch] text-[11.5px] leading-relaxed text-pulpitry-muted">
            Everything else here stays free and on this machine: your own
            library, imports from EasyWorship, ProPresenter, OpenLP and
            OpenSong, and anything you write yourself.
          </p>
          <p className="text-[11.5px] text-pulpitry-teal">
            Settings → Subscription
          </p>
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-pulpitry-line px-2.5 py-2">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void look(query);
              }}
            >
              <input
                value={query}
                spellCheck={false}
                placeholder="A title, an author, or a line of the words…"
                aria-label="Search the Songbook"
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
              />
            </form>
          </div>

          {error ? (
            <p className="px-3 py-2 text-[12px] leading-relaxed text-pulpitry-gold">
              {error}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {!hits && !looking && !error ? (
              <EmptyState>
                Type a title, an author, or a line you remember.
              </EmptyState>
            ) : null}

            {looking && !hits ? (
              <p className="px-3 py-4 text-center text-[12px] text-pulpitry-muted">
                Looking…
              </p>
            ) : null}

            {hits && hits.length === 0 ? (
              <EmptyState>
                Nothing for “{query}”. Try a line of the words instead of the
                title — a song is often catalogued under a name nobody uses.
              </EmptyState>
            ) : null}

            {(hits ?? []).map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => onChoose(hit)}
                title="Look at it before adding it"
                className={`w-full rounded border px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                  hit.id === chosen
                    ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim"
                    : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-pulpitry-text">
                    {hit.title}
                  </span>
                  {/* What is known about the rights, in the list rather than
                      only on the song: an operator scanning results is
                      entitled to see which of them they may actually use. */}
                  <span
                    className={`shrink-0 text-[10.5px] ${
                      hit.rights === "restricted"
                        ? "text-pulpitry-gold"
                        : "text-pulpitry-muted"
                    }`}
                  >
                    {RIGHTS_LABEL[hit.rights] ?? hit.rights}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-pulpitry-muted">
                  {[hit.author, hit.opening].filter(Boolean).join(" · ")}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
