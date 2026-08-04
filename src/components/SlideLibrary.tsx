import { useCallback, useEffect, useState } from "react";

import { catalogList, catalogRemove, catalogSave, newItem, type Item } from "../lib/catalog";
import type { TextBlock } from "../lib/projector";
import { presentableFor } from "../lib/schedule";
import type { ProjectorTheme } from "../lib/theme";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";
import { SlideCanvas } from "./SlideCanvas";

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

const TOOL =
  "rounded border border-pulpitry-line px-1.5 py-0.5 text-[11px] text-pulpitry-muted transition-colors hover:border-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring";

const ON = "border-pulpitry-gold-dim text-pulpitry-gold";

const ALIGNMENTS = ["left", "center", "right"] as const;

function blankBlock(): TextBlock {
  return { text: "", level: "body", align: "center", bold: false, italic: false };
}

/**
 * Slides the operator writes themselves: a welcome, a notice, a title card.
 *
 * Text is held as a closed set of fields rather than markup. Rich text from an
 * editor would have to be sanitised before the projector could show it, and
 * getting that wrong is a real hazard; these blocks cannot carry markup at all.
 */
export function SlideLibrary({
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
  const [slides, setSlides] = useState<Item[]>([]);
  const [editing, setEditing] = useState<{
    id: number | null;
    title: string;
    blocks: TextBlock[];
  } | null>(null);
  // Formatting applies to the line being written, so one toolbar serves them
  // all rather than repeating six controls on every row.
  const [focused, setFocused] = useState(0);

  const fail = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  const refresh = useCallback(async () => {
    try {
      setSlides(await catalogList("slide"));
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    if (!title) return;
    // Empty lines are spacing while writing but nothing on a screen.
    const blocks = editing.blocks.filter((block) => block.text.trim().length > 0);
    try {
      const item: Item = {
        ...(editing.id === null
          ? newItem(title, { kind: "slide", blocks })
          : { id: editing.id, title, subtitle: "", body: { kind: "slide", blocks }, path: null, updatedAt: 0 }),
      };
      await catalogSave(item);
      setEditing(null);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (id: number) => {
    try {
      await catalogRemove(id);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  if (editing) {
    const update = (index: number, change: Partial<TextBlock>) =>
      setEditing({
        ...editing,
        blocks: editing.blocks.map((block, at) =>
          at === index ? { ...block, ...change } : block,
        ),
      });
    const current = editing.blocks[focused];

    return (
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2">
        <input
          value={editing.title}
          placeholder="Title — how you will find it later"
          autoFocus
          onChange={(event) => setEditing({ ...editing, title: event.target.value })}
          className={FIELD}
        />

        <SlideCanvas blocks={editing.blocks} theme={theme} />

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() =>
              update(focused, { level: current?.level === "heading" ? "body" : "heading" })
            }
            className={`${TOOL} ${current?.level === "heading" ? ON : ""}`}
            title="Larger, for the line that carries the slide"
          >
            Heading
          </button>
          <button
            type="button"
            onClick={() => update(focused, { bold: !current?.bold })}
            className={`${TOOL} ${current?.bold ? ON : ""}`}
            aria-label="Bold"
          >
            <span className="font-semibold">B</span>
          </button>
          <button
            type="button"
            onClick={() => update(focused, { italic: !current?.italic })}
            className={`${TOOL} ${current?.italic ? ON : ""}`}
            aria-label="Italic"
          >
            <span className="italic">I</span>
          </button>
          {ALIGNMENTS.map((align) => (
            <button
              key={align}
              type="button"
              onClick={() => update(focused, { align })}
              className={`${TOOL} ${current?.align === align ? ON : ""}`}
              aria-label={`Align ${align}`}
            >
              {align === "left" ? "◧" : align === "center" ? "▣" : "◨"}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-pulpitry-muted">
            Line {focused + 1}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          {editing.blocks.map((block, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                value={block.text}
                placeholder={index === 0 ? "Welcome" : "Another line"}
                aria-label={`Line ${index + 1}`}
                onFocus={() => setFocused(index)}
                onChange={(event) => update(index, { text: event.target.value })}
                className={`min-w-0 flex-1 ${FIELD} ${
                  focused === index ? "border-pulpitry-teal" : ""
                }`}
              />
              <button
                type="button"
                onClick={() => {
                  setEditing({
                    ...editing,
                    blocks: editing.blocks.filter((_, at) => at !== index),
                  });
                  setFocused((at) => Math.max(0, at > index ? at - 1 : at));
                }}
                disabled={editing.blocks.length === 1}
                aria-label={`Remove line ${index + 1}`}
                className="shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-pulpitry-muted hover:text-pulpitry-text disabled:opacity-30 focus-visible:focus-ring"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setEditing({ ...editing, blocks: [...editing.blocks, blankBlock()] });
            setFocused(editing.blocks.length);
          }}
          className={`${TOOL} self-start`}
        >
          Add line
        </button>

        <p className="text-[11px] text-pulpitry-muted">
          {editing.title.trim()
            ? "Shown exactly as above, on the projector theme in Settings."
            : "Give it a title to save."}
        </p>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editing.title.trim()}
            title={editing.title.trim() ? "Save this slide" : "A title is needed first"}
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
      <div className="flex shrink-0 justify-end border-b border-pulpitry-line px-2.5 py-2">
        <button
          type="button"
          onClick={() => {
            setFocused(0);
            setEditing({ id: null, title: "", blocks: [blankBlock()] });
          }}
          title="Write a slide"
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
        >
          New
        </button>
      </div>

      {slides.length === 0 ? (
        <EmptyState>
          No slides yet. Press New to write one — a welcome, a notice, a title card.
        </EmptyState>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] content-start gap-2 overflow-auto p-2">
          {slides.map((item) => {
            const staged = presentableFor(item);
            const key = staged ? keyOf(staged) : "";
            const state = key === liveKey ? "live" : key === previewKey ? "preview" : "idle";
            const blocks = item.body.kind === "slide" ? item.body.blocks : [];

            return (
              <div key={item.id} className="group relative flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => staged && onPreview(staged)}
                  title={item.title}
                  className="block text-left focus-visible:focus-ring"
                >
                  <span
                    className={`block rounded ${
                      state === "live"
                        ? "ring-2 ring-pulpitry-gold"
                        : state === "preview"
                          ? "ring-2 ring-pulpitry-teal"
                          : ""
                    }`}
                  >
                    <SlideCanvas blocks={blocks} theme={theme} />
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-pulpitry-muted">
                    {item.title}
                  </span>
                </button>

                <span className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    onClick={() =>
                      item.body.kind === "slide" &&
                      (setFocused(0),
                      setEditing({ id: item.id, title: item.title, blocks: item.body.blocks.length > 0 ? item.body.blocks : [blankBlock()] }))
                    }
                    className="rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[11px] text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => item.id !== null && void remove(item.id)}
                    aria-label={`Remove ${item.title}`}
                    className="rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[12px] leading-none text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
