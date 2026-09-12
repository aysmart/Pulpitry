import { useCallback, useEffect, useState } from "react";

import {
  catalogList,
  catalogRemove,
  catalogSave,
  catalogSearch,
  newItem,
  unknownRights,
  type Item,
  type ItemBody,
  type RightsStatus,
  type SongRights,
  type SongSection,
} from "../lib/catalog";
import type { ProjectorTheme } from "../lib/theme";
import { parseSections, screensOf } from "../lib/lyrics";
import { presentableFor } from "../lib/schedule";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";
import { SongEditor } from "./SongEditor";
import { SongImport } from "./SongImport";

function toText(sections: SongSection[]): string {
  return sections
    .map((section) => [section.label, ...section.lines].filter(Boolean).join("\n"))
    .join("\n\n");
}

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

/**
 * How each rights answer is shown.
 *
 * Only two of the four get a badge in the list. "Public domain" is the answer
 * for most of the library and marking it everywhere would turn the badge into
 * wallpaper; "licensed" is a settled question and needs no flag either. What an
 * operator has to see at a glance is the song nobody has answered for, and the
 * one that has been answered with no.
 */
const RIGHTS: Record<
  RightsStatus,
  { label: string; badge: string | null; className: string; note: string }
> = {
  publicDomain: {
    label: "Public domain",
    badge: null,
    className: "",
    note: "Old enough, or dedicated. No licence is needed by anyone.",
  },
  licensed: {
    label: "Covered by our licence",
    badge: null,
    className: "",
    note: "Under copyright, and covered by a licence this church holds. Record the CCLI number so it can be reported.",
  },
  unknown: {
    label: "Not established",
    badge: "?",
    className: "border-pulpitry-line text-pulpitry-muted",
    note: "Nobody has checked. This is not the same as cleared — most worship music written since 1930 needs a licence.",
  },
  restricted: {
    label: "Needs a licence we do not have",
    badge: "!",
    className: "border-pulpitry-gold/60 text-pulpitry-gold",
    note: "Kept in the library so it can be found and planned for, but not cleared to project.",
  },
};

/** A quiet mark on songs whose rights are unanswered or refused. */
function RightsBadge({ status }: { status: RightsStatus }) {
  const rights = RIGHTS[status];
  if (!rights.badge) return null;
  return (
    <span
      title={`${rights.label}. ${rights.note}`}
      aria-label={rights.label}
      className={`shrink-0 rounded border px-1 text-[9.5px] leading-[1.35] ${rights.className}`}
    >
      {rights.badge}
    </span>
  );
}

/**
 * The provenance fields, folded away until asked for.
 *
 * Below the lyrics and closed by default because it is not what an operator
 * came here to type. It is what somebody has to be able to answer later, and a
 * form that demanded it before a song could be saved would only teach people to
 * put anything in the box.
 */

/**
 * Every section item carries the song's whole section list, so Prev and Next
 * can walk it without a database round trip mid-service.
 */
function sectionItem(song: Item, sections: SongSection[], index: number): Presentable {
  return {
    kind: "lyric",
    songId: song.id ?? 0,
    title: song.title,
    index,
    sections,
    source: "song",
  };
}

/** The sections of one song, as slides or as a list. */
function SongSections({
  song,
  sections,
  keyOf,
  previewKey,
  liveKey,
  onPreview,
}: {
  song: Item;
  sections: SongSection[];
  keyOf: (item: Presentable) => string;
  previewKey: string | null;
  liveKey: string | null;
  /**
   * Stages an item. `andShow` puts it on screen in the same gesture — a
   * double-click, for when the operator already knows what they want there.
   */
  onPreview: (item: Presentable, andShow?: boolean) => void;
}) {
  const stateOf = (key: string) =>
    key === liveKey ? "live" : key === previewKey ? "preview" : "idle";

  /*
   * The words, as the screenfuls they will be shown in.
   *
   * Not thumbnails. A song is not a deck: a thumbnail of two lines of type is
   * a picture of some words, which is a slower way of reading the words. And
   * two verses of the same song make two identical-looking tiles, so the one
   * thing a picture is good for -- recognising something at a glance -- is the
   * one thing it cannot do here.
   */
  return (
    <ul className="flex flex-col gap-0.5 px-2 py-1">
      {sections.map((section, index) => {
        const item = sectionItem(song, sections, index);
        const state = stateOf(keyOf(item));
        return (
          <li key={index}>
            <button
              type="button"
              onClick={() => onPreview(item)}
              onDoubleClick={() => onPreview(item, true)}
              title="Click to stage, double-click to put it on screen"
              className={`w-full rounded border px-2 py-1 text-left transition-colors focus-visible:focus-ring ${
                state === "live"
                  ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                  : state === "preview"
                    ? "border-pulpitry-teal-dim bg-pulpitry-teal-dim"
                    : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
              }`}
            >
              <span
                className={`block text-[10.5px] tracking-[0.08em] uppercase ${
                  state === "live" ? "text-pulpitry-gold" : "text-pulpitry-muted"
                }`}
              >
                {section.label || `Part ${index + 1}`}
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-pulpitry-text">
                {section.lines.map((line, at) => (
                  <span key={at} className="block truncate">
                    {line}
                  </span>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function SongLibrary({
  theme,
  onApplyTheme,
  onPreview,
  onAddToSet,
  previewKey,
  liveKey,
  keyOf,
  onError,
}: {
  theme: ProjectorTheme;
  /** Saving a change to the church's look, made while a song is being set. */
  onApplyTheme: (theme: ProjectorTheme) => void;
  onPreview: (item: Presentable, andShow?: boolean) => void;
  /**
   * Puts a song in the set being built, without staging it.
   *
   * Absent on every arrangement but the song desk, and the plus is absent with
   * it: a control that adds to a list nobody can see is a control that gets
   * pressed twice and trusted never.
   */
  onAddToSet?: (item: Presentable) => void;
  previewKey: string | null;
  liveKey: string | null;
  keyOf: (item: Presentable) => string;
  onError: (message: string) => void;
}) {
  const [songs, setSongs] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [editing, setEditing] = useState<{
    title: string;
    subtitle: string;
    body: string;
    rights: SongRights;
  } | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(
    async (keep?: number | null) => {
      try {
        const found = query.trim()
          ? await catalogSearch(query, "song")
          : await catalogList("song");
        setSongs(found);
        if (keep != null) setSelected(found.find((song) => song.id === keep) ?? null);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [query, onError],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (song: {
    title: string;
    author: string;
    sections: SongSection[];
    rights: SongRights;
  }) => {
    const title = song.title.trim();
    if (!title) return;
    try {
      const body: ItemBody = {
        kind: "song",
        sections: song.sections,
        rights: song.rights,
      };
      const item: Item = selected
        ? { ...selected, title, subtitle: song.author, body }
        : { ...newItem(title, body), subtitle: song.author };
      const saved = await catalogSave(item);
      setEditing(null);
      await refresh(saved.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: number) => {
    try {
      await catalogRemove(id);
      setSelected(null);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  if (importing) {
    return (
      <SongImport
        onClose={() => setImporting(false)}
        onImported={() => void refresh()}
        onError={onError}
      />
    );
  }

  if (editing) {
    return (
      <SongEditor
        title={editing.title}
        author={editing.subtitle}
        sections={parseSections(editing.body)}
        rights={editing.rights}
        theme={theme}
        onTheme={onApplyTheme}
        parse={parseSections}
        toText={toText}
        onClose={() => setEditing(null)}
        onSave={(song) => {
          void save(song);
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1.5 border-b border-pulpitry-line px-2.5 py-2">
        <input
          value={query}
          placeholder="Search titles and lyrics…"
          onChange={(event) => setQuery(event.target.value)}
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        <button
          type="button"
          onClick={() => setImporting(true)}
          title="Bring a library over from EasyWorship, OpenLP or OpenSong"
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
        >
          Import
        </button>
        <button
          type="button"
          onClick={() => {
            // Without this the save path treats a new song as an edit of
            // whichever one is open and overwrites it.
            setSelected(null);
            setEditing({ title: "", subtitle: "", body: "", rights: unknownRights() });
          }}
          title="Add a song"
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
        >
          New
        </button>
      </div>

      {songs.length === 0 ? (
        <EmptyState>
          {query.trim()
            ? `Nothing matching “${query}”.`
            : "No songs yet. Press Import to bring a library over from EasyWorship, OpenLP or OpenSong, or New to add one — paste the lyrics and blank lines will split them into slides."}
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ul className="flex flex-col p-1">
            {songs.map((song) => {
              const open = selected?.id === song.id;
              return (
                <li key={song.id}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelected(open ? null : song)}
                      className={`min-w-0 flex-1 rounded px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                        open ? "bg-pulpitry-teal-dim" : "hover:bg-pulpitry-raised"
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-[12.5px] text-pulpitry-text">
                        <span className="min-w-0 truncate">{song.title}</span>
                        {song.body.kind === "song" ? (
                          <RightsBadge status={song.body.rights.status} />
                        ) : null}
                      </span>
                      {song.subtitle ? (
                        <span className="block truncate text-[11px] text-pulpitry-muted">
                          {song.subtitle}
                        </span>
                      ) : null}
                    </button>
                    {/*
                      Straight into the set, without staging it.

                      A worship leader building Sunday adds five songs in a
                      row, and none of them is the one they want on the screen
                      -- so this is deliberately not the click that stages.
                      Shown on every row rather than only the open one: adding
                      is the commonest thing done here, and needing to open a
                      song first would make it two presses each.
                    */}
                    {onAddToSet ? (
                      <button
                        type="button"
                        onClick={() => {
                          const staged = presentableFor(song);
                          if (staged) onAddToSet(staged);
                        }}
                        title={`Add ${song.title} to the set`}
                        aria-label={`Add ${song.title} to the set`}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[14px] leading-none text-pulpitry-muted transition-colors hover:text-pulpitry-gold focus-visible:focus-ring"
                      >
                        +
                      </button>
                    ) : null}
                    {open ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({
                              title: song.title,
                              subtitle: song.subtitle,
                              body: song.body.kind === "song" ? toText(song.body.sections) : "",
                              rights:
                                song.body.kind === "song" ? song.body.rights : unknownRights(),
                            })
                          }
                          className="rounded px-1.5 py-0.5 text-[11px] text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => song.id !== null && void remove(song.id)}
                          aria-label={`Delete ${song.title}`}
                          className="rounded px-1.5 py-0.5 text-[13px] leading-none text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
                        >
                          ×
                        </button>
                      </>
                    ) : null}
                  </div>

                  {/* The song's parts, as the screenfuls they will be shown
                      in: the operator picks the chorus by reading the words of
                      it, which is the only thing that tells two verses apart. */}
                  {open && song.body.kind === "song" ? (
                    <SongSections
                      song={song}
                      sections={screensOf(song.body.sections)}
                      keyOf={keyOf}
                      previewKey={previewKey}
                      liveKey={liveKey}
                      onPreview={onPreview}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
