import { useCallback, useEffect, useState } from "react";

import {
  catalogList,
  catalogRemove,
  catalogSave,
  catalogSearch,
  newItem,
  type Item,
  type SongSection,
} from "../lib/catalog";
import type { ProjectorTheme } from "../lib/theme";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";
import { SlideThumb } from "./SlideThumb";

/**
 * Sections are written as plain text, blank line between blocks, an optional
 * label on its own first line. Typing that is far quicker than filling in a
 * form for every verse and chorus, and it is how lyrics arrive when pasted.
 */
function parseSections(text: string): SongSection[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").filter((line) => line.trim() !== ""))
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const first = lines[0]!.trim();
      // A short first line with no sentence punctuation reads as a label.
      const isLabel = lines.length > 1 && first.length <= 24 && !/[.,;!?]$/.test(first);
      return {
        label: isLabel ? first : "",
        lines: isLabel ? lines.slice(1) : lines,
      };
    });
}

function toText(sections: SongSection[]): string {
  return sections
    .map((section) => [section.label, ...section.lines].filter(Boolean).join("\n"))
    .join("\n\n");
}

/**
 * Thumbnails or a text list.
 *
 * Slides are quicker to recognise; a list is quicker to scan and fits far more
 * on screen at once. Which is better depends on the song and the operator, so
 * it is a choice rather than a decision, remembered between sessions.
 */
type View = "slides" | "list";

const VIEW_KEY = "pulpitry.songs.view";

function storedView(): View {
  return (localStorage.getItem(VIEW_KEY) as View | null) ?? "slides";
}

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

/**
 * Every section item carries the song's whole section list, so Prev and Next
 * can walk it without a database round trip mid-service.
 */
function sectionItem(song: Item, sections: SongSection[], index: number): Presentable {
  return { kind: "lyric", songId: song.id ?? 0, title: song.title, index, sections };
}

/** The sections of one song, as slides or as a list. */
function SongSections({
  song,
  sections,
  view,
  theme,
  keyOf,
  previewKey,
  liveKey,
  onPreview,
}: {
  song: Item;
  sections: SongSection[];
  view: View;
  theme: ProjectorTheme;
  keyOf: (item: Presentable) => string;
  previewKey: string | null;
  liveKey: string | null;
  onPreview: (item: Presentable) => void;
}) {
  const stateOf = (key: string) =>
    key === liveKey ? "live" : key === previewKey ? "preview" : "idle";

  if (view === "slides") {
    return (
      <div className="grid grid-cols-2 gap-2 px-2 py-2">
        {sections.map((section, index) => {
          const item = sectionItem(song, sections, index);
          return (
            <SlideThumb
              key={index}
              item={item}
              theme={theme}
              label={section.label || `Slide ${index + 1}`}
              state={stateOf(keyOf(item))}
              onSelect={() => onPreview(item)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <ul className="flex flex-col px-2 py-1">
      {sections.map((section, index) => {
        const item = sectionItem(song, sections, index);
        const state = stateOf(keyOf(item));
        return (
          <li key={index}>
            <button
              type="button"
              onClick={() => onPreview(item)}
              className={`flex w-full gap-2 rounded px-2 py-1 text-left transition-colors focus-visible:focus-ring ${
                state === "live"
                  ? "bg-pulpitry-gold/12"
                  : state === "preview"
                    ? "bg-pulpitry-teal-dim"
                    : "hover:bg-pulpitry-raised"
              }`}
            >
              <span
                className={`w-[4.5rem] shrink-0 truncate text-[11px] ${
                  state === "live" ? "text-pulpitry-gold" : "text-pulpitry-muted"
                }`}
              >
                {section.label || `Slide ${index + 1}`}
              </span>
              <span className="truncate text-[12.5px] text-pulpitry-text">
                {section.lines[0] ?? ""}
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
  onPreview,
  previewKey,
  liveKey,
  keyOf,
  onError,
}: {
  theme: ProjectorTheme;
  onPreview: (item: Presentable) => void;
  previewKey: string | null;
  liveKey: string | null;
  keyOf: (item: Presentable) => string;
  onError: (message: string) => void;
}) {
  const [songs, setSongs] = useState<Item[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [view, setView] = useState<View>(storedView);
  const [editing, setEditing] = useState<{ title: string; author: string; body: string } | null>(
    null,
  );

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

  const save = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    if (!title) return;
    try {
      const sections = parseSections(editing.body);
      const item: Item = selected
        ? { ...selected, title, subtitle: editing.author.trim(), body: { kind: "song", sections } }
        : { ...newItem(title, { kind: "song", sections }), subtitle: editing.author.trim() };
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

  if (editing) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2">
        <input
          value={editing.title}
          placeholder="Title"
          autoFocus
          onChange={(event) => setEditing({ ...editing, title: event.target.value })}
          className={FIELD}
        />
        <input
          value={editing.author}
          placeholder="Author or attribution"
          onChange={(event) => setEditing({ ...editing, author: event.target.value })}
          className={FIELD}
        />
        <textarea
          value={editing.body}
          placeholder={"Verse 1\nAmazing grace how sweet the sound\nthat saved a wretch like me\n\nChorus\n…"}
          onChange={(event) => setEditing({ ...editing, body: event.target.value })}
          className={`${FIELD} min-h-0 flex-1 resize-none font-[inherit] leading-relaxed`}
        />
        <p className="text-[11px] text-pulpitry-muted">
          {editing.title.trim()
            ? "A blank line starts a new slide. A short first line becomes its label."
            : "Give it a title to save."}
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editing.title.trim()}
            title={editing.title.trim() ? "Save this song" : "A title is needed first"}
            className="flex-1 rounded bg-pulpitry-gold px-3 py-1.5 text-[12.5px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
          >
            Cancel
          </button>
        </div>
      </div>
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
          onClick={() => {
            const next = view === "slides" ? "list" : "slides";
            setView(next);
            localStorage.setItem(VIEW_KEY, next);
          }}
          title={view === "slides" ? "Show sections as a list" : "Show sections as slides"}
          aria-label={view === "slides" ? "Show sections as a list" : "Show sections as slides"}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
            {view === "slides" ? (
              <>
                <rect x="1" y="2" width="14" height="2.4" rx="0.6" />
                <rect x="1" y="6.8" width="14" height="2.4" rx="0.6" />
                <rect x="1" y="11.6" width="14" height="2.4" rx="0.6" />
              </>
            ) : (
              <>
                <rect x="1" y="2" width="6.2" height="5" rx="0.8" />
                <rect x="8.8" y="2" width="6.2" height="5" rx="0.8" />
                <rect x="1" y="9" width="6.2" height="5" rx="0.8" />
                <rect x="8.8" y="9" width="6.2" height="5" rx="0.8" />
              </>
            )}
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            // Without this the save path treats a new song as an edit of
            // whichever one is open and overwrites it.
            setSelected(null);
            setEditing({ title: "", author: "", body: "" });
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
            : "No songs yet. Press New to add one — paste the lyrics and blank lines will split them into slides."}
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
                      <span className="block truncate text-[12.5px] text-pulpitry-text">
                        {song.title}
                      </span>
                      {song.subtitle ? (
                        <span className="block truncate text-[11px] text-pulpitry-muted">
                          {song.subtitle}
                        </span>
                      ) : null}
                    </button>
                    {open ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({
                              title: song.title,
                              author: song.subtitle,
                              body: song.body.kind === "song" ? toText(song.body.sections) : "",
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

                  {/* Sections as rendered slides: the operator picks the chorus
                      by recognising it, not by reading a list. */}
                  {open && song.body.kind === "song" ? (
                    <SongSections
                      song={song}
                      sections={song.body.sections}
                      view={view}
                      theme={theme}
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
