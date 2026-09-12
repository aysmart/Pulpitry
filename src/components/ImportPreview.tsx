import { useEffect, useState } from "react";

import { describeError } from "../lib/api";
import type { Item } from "../lib/catalog";
import {
  RIGHTS_LABEL,
  songFinderAdd,
  songFinderGet,
  type SongFinderHit,
  type SongFinderSong,
} from "../lib/songfinder";
import { EmptyState, Panel } from "./Panel";

/**
 * What would be added, before it is.
 *
 * # Why a whole pane for it
 *
 * Because a catalogue entry is a claim about a song and the operator is the one
 * who has to stand behind it on Sunday. Two things need looking at and neither
 * fits in a list: whether these are the *right* words — a title can be shared
 * by four songs, and a chorus can be catalogued under a line nobody sings — and
 * what is known about the rights.
 *
 * # The rights line is not decoration
 *
 * Pulpitry deliberately does not integrate CCLI: that is a licence the church
 * holds and reports against, not a service an application can call, and
 * pretending otherwise would put us between a church and its own legal
 * position. What an application can do is refuse to let the question go
 * unasked. A song whose terms nobody has checked says so here, in the place
 * where somebody is deciding to use it.
 */
export function ImportPreview({
  hit,
  onAdded,
  onError,
}: {
  /** The catalogue entry being looked at, or null. */
  hit: SongFinderHit | null;
  /** The saved row, so the library can refresh and stage it. */
  onAdded: (item: Item) => void;
  onError: (message: string) => void;
}) {
  const [song, setSong] = useState<SongFinderSong | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hit) {
      setSong(null);
      setError(null);
      return;
    }

    let live = true;
    setLoading(true);
    setError(null);
    void songFinderGet(hit.id)
      .then((found) => live && setSong(found))
      .catch((err) => {
        if (live) {
          setError(describeError(err));
          setSong(null);
        }
      })
      .finally(() => live && setLoading(false));

    return () => {
      live = false;
    };
  }, [hit]);

  const add = async () => {
    if (!hit || adding) return;
    setAdding(true);
    try {
      onAdded(await songFinderAdd(hit.id));
    } catch (err) {
      onError(describeError(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Panel
      title="Before you add it"
      actions={
        song ? (
          <button
            type="button"
            onClick={() => void add()}
            disabled={adding}
            title="Copy it into this church's library"
            className="rounded bg-pulpitry-gold px-2.5 py-1 text-[11.5px] text-pulpitry-ink disabled:opacity-50 focus-visible:focus-ring"
          >
            {adding ? "Adding…" : "Add to my library"}
          </button>
        ) : null
      }
    >
      {!hit ? (
        <EmptyState>
          Pick a song from the AI Song Finder and its words appear here.
        </EmptyState>
      ) : loading ? (
        <p className="px-3 py-4 text-center text-[12px] text-pulpitry-muted">
          Fetching the words…
        </p>
      ) : error ? (
        <p className="px-3 py-3 text-[12px] leading-relaxed text-pulpitry-gold">
          {error}
        </p>
      ) : song ? (
        <div className="flex flex-col gap-2 p-2.5">
          <div>
            <p className="text-[13.5px] text-pulpitry-text">{song.title}</p>
            {song.author ? (
              <p className="text-[11.5px] text-pulpitry-muted">{song.author}</p>
            ) : null}
          </div>

          {/*
            The terms, verbatim where there are any.

            Our own summary of a publisher's sentence is worth less than the
            sentence, and somebody checking this claim wants what was actually
            written.
          */}
          <div className="rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5">
            <p
              className={`text-[11.5px] ${
                song.rights.status === "restricted"
                  ? "text-pulpitry-gold"
                  : "text-pulpitry-text"
              }`}
            >
              {RIGHTS_LABEL[song.rights.status] ?? song.rights.status}
            </p>
            {song.rights.terms ? (
              <p className="mt-1 text-[11px] leading-relaxed text-pulpitry-muted">
                {song.rights.terms}
              </p>
            ) : null}
            {song.rights.status === "unknown" ? (
              <p className="mt-1 text-[11px] leading-relaxed text-pulpitry-muted">
                Nobody has checked the terms for this one. If your church holds
                a CCLI licence, put your song number on it after adding — the
                reporting is yours, and Pulpitry sends nothing anywhere.
              </p>
            ) : null}
          </div>

          {song.sections.map((section, index) => (
            <div key={`${section.label}-${index}`}>
              <p className="text-[10.5px] tracking-[0.1em] text-pulpitry-muted uppercase">
                {section.label || `Part ${index + 1}`}
              </p>
              {/* The line breaks are the writer's, and a lyric that reflows
                  into a paragraph is a lyric nobody can sing from. */}
              <p className="mt-0.5 text-[12.5px] leading-snug whitespace-pre-wrap text-pulpitry-text">
                {section.lines.join("\n")}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
