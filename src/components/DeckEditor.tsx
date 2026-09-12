import { useCallback, useEffect, useRef, useState } from "react";

import { open } from "@tauri-apps/plugin-dialog";

import { scriptureIn } from "../lib/bible";
import { catalogSave, type Item, type SongSection } from "../lib/catalog";
import {
  CANVAS,
  DEFAULT_BACKGROUND,
  GRADIENT_PRESETS,
  MOTIONS,
  SHAPES,
  SHAPE_LABELS,
  isTypeset,
  newImage,
  newScripture,
  newShape,
  newTable,
  newText,
  reidentify,
  withBackground,
  within,
  type Background,
  type ShapeKind,
  type SlideElement,
  type TableElement,
  type Typeset,
} from "../lib/design";
import { promote } from "../lib/promote";
import { FONT_FAMILIES, type ProjectorTheme } from "../lib/theme";
import { Backdrop } from "./Backdrop";
import { boxStyle, DesignedView, typeStyle } from "./DesignedView";

const FIELD =
  "w-full rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

const BUTTON =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring";

/** The shapes, drawn rather than named — though both are offered. */
function ShapeGlyph({ shape }: { shape: ShapeKind }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" aria-hidden>
      {shape === "rectangle" ? <rect x="2" y="4" width="16" height="12" {...common} /> : null}
      {shape === "rounded" ? <rect x="2" y="4" width="16" height="12" rx="4" {...common} /> : null}
      {shape === "circle" ? <circle cx="10" cy="10" r="7" {...common} /> : null}
      {shape === "ellipse" ? <ellipse cx="10" cy="10" rx="8" ry="5.5" {...common} /> : null}
      {shape === "triangle" ? <path d="M10 3 18 17H2Z" {...common} /> : null}
      {shape === "diamond" ? <path d="M10 2 18 10 10 18 2 10Z" {...common} /> : null}
      {shape === "chevron" ? <path d="M3 4h8l5 6-5 6H3l5-6Z" {...common} /> : null}
      {shape === "star" ? (
        <path d="M10 2.5 12.2 8h5.6l-4.5 3.4 1.7 5.4L10 13.6l-5 3.2 1.7-5.4L2.2 8h5.6Z" {...common} />
      ) : null}
      {shape === "line" ? (
        <path d="M3 10h14" {...common} strokeWidth={2.4} strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/** A blank deck, with one page, ready to be drawn on. */
export function blankDeck(): Item {
  return {
    id: null,
    title: "",
    subtitle: "",
    body: {
      kind: "deck",
      sections: [{ label: "Page 1", lines: [], elements: [newText("Title")] }],
      background: DEFAULT_BACKGROUND,
    },
    path: null,
    updatedAt: 0,
  };
}

function Collapsible({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="border-b border-pulpitry-line px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:focus-ring"
      >
        <span>
          <span className="block text-[13px] text-pulpitry-text">{title}</span>
          {note ? (
            <span className="block text-[11px] text-pulpitry-muted">
              {note}
            </span>
          ) : null}
        </span>
        <span className="text-[11px] text-pulpitry-muted">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open ? <div className="mt-2 flex flex-col gap-2">{children}</div> : null}
    </section>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="min-w-0 flex-1">
      <span className="mb-1 block text-[11px] text-pulpitry-muted">
        {label}
      </span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(event) => {
          const next = numeric(event.target.value);
          if (next !== null) onChange(next);
        }}
        className={FIELD}
      />
    </label>
  );
}

/** Empty and half-typed values must not become NaN in a stored slide. */
function numeric(raw: string): number | null {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function Segment<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="min-w-0 flex-1">
      <span className="mb-1 block text-[11px] text-pulpitry-muted">
        {label}
      </span>
      <div className="flex items-center gap-0.5 rounded border border-pulpitry-line bg-pulpitry-raised p-0.5">
        {options.map(([id, glyph, hint]) => (
          <button
            key={id}
            type="button"
            title={hint}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={`min-w-0 flex-1 rounded px-1 py-1 text-[12px] transition-colors focus-visible:focus-ring ${
              value === id
                ? "bg-pulpitry-teal-dim text-pulpitry-text"
                : "text-pulpitry-muted hover:text-pulpitry-text"
            }`}
          >
            {glyph}
          </button>
        ))}
      </div>
    </div>
  );
}

function Colour({
  label,
  value,
  onChange,
  opacity,
  onOpacity,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  opacity?: number;
  onOpacity?: (value: number) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-[11px] text-pulpitry-muted">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={value}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-9 shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised focus-visible:focus-ring"
        />
        <input
          value={value.replace("#", "")}
          spellCheck={false}
          onChange={(event) => {
            const hex = event.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
            onChange(`#${hex.padEnd(6, hex.slice(-1) || "0")}`);
          }}
          className={`min-w-0 flex-1 ${FIELD}`}
        />
        {onOpacity ? (
          <span className="flex shrink-0 items-center gap-1">
            <input
              type="number"
              min={0}
              max={100}
              value={opacity ?? 100}
              aria-label={`${label} opacity`}
              onChange={(event) => {
                const next = numeric(event.target.value);
                if (next !== null) onOpacity(Math.max(0, Math.min(100, next)));
              }}
              className={`w-[3.6rem] ${FIELD}`}
            />
            <span className="text-[11px] text-pulpitry-muted">%</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The cells of a table, edited as a grid.
 *
 * A grid rather than a text field with separators, because that is the shape of
 * the thing: a comparison has columns whose headings mean something, and asking
 * somebody to keep tabs and commas lined up is asking them to maintain a data
 * format by hand. Rows and columns are added and removed from the ends, which
 * is where a rota or a set of figures grows.
 */
function TableFields({
  element,
  onChange,
}: {
  element: TableElement;
  onChange: (patch: Partial<TableElement>) => void;
}) {
  const columns = Math.max(element.header.length, 1);

  /** Every row the same length, whatever was stored or pasted in. */
  const square = (rows: string[][], width: number) =>
    rows.map((row) =>
      Array.from({ length: width }, (_, index) => row[index] ?? ""),
    );

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-pulpitry-muted">
          Headings — leave them empty for a table with no head
        </span>
        <div className="flex gap-1">
          {element.header.map((cell, column) => (
            <input
              key={column}
              value={cell}
              aria-label={`Heading ${column + 1}`}
              onChange={(event) =>
                onChange({
                  header: element.header.map((current, index) =>
                    index === column ? event.target.value : current,
                  ),
                })
              }
              className={`min-w-0 flex-1 ${FIELD}`}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {element.rows.map((row, at) => (
          <div key={at} className="flex items-center gap-1">
            {Array.from({ length: columns }, (_, column) => (
              <input
                key={column}
                value={row[column] ?? ""}
                aria-label={`Row ${at + 1}, column ${column + 1}`}
                onChange={(event) =>
                  onChange({
                    rows: element.rows.map((current, index) =>
                      index === at
                        ? Array.from({ length: columns }, (_, cell) =>
                            cell === column
                              ? event.target.value
                              : (current[cell] ?? ""),
                          )
                        : current,
                    ),
                  })
                }
                className={`min-w-0 flex-1 ${FIELD}`}
              />
            ))}
            <button
              type="button"
              onClick={() =>
                onChange({
                  rows: element.rows.filter((_, index) => index !== at),
                })
              }
              aria-label={`Remove row ${at + 1}`}
              className="shrink-0 rounded px-1 text-[13px] leading-none text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() =>
            onChange({
              rows: [...element.rows, Array.from({ length: columns }, () => "")],
            })
          }
          className={`flex-1 ${BUTTON}`}
        >
          Add row
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              header: [...element.header, ""],
              rows: square(element.rows, columns + 1),
            })
          }
          className={`flex-1 ${BUTTON}`}
        >
          Add column
        </button>
        <button
          type="button"
          disabled={columns <= 1}
          onClick={() =>
            onChange({
              header: element.header.slice(0, -1),
              rows: square(element.rows, columns - 1),
            })
          }
          title="Remove the last column"
          className={BUTTON}
        >
          −
        </button>
      </div>
    </>
  );
}

/**
 * Making a slide deck by hand.
 *
 * # Why a design surface at all
 *
 * Everything else in Pulpitry decides a layout for the operator, and for most
 * of a service that is right: a verse, a lyric and a generated sermon deck all
 * want the same treatment every week, and a church running a Sunday should not
 * be positioning anything. But the four slides they make on purpose — the
 * welcome, the notices, the giving details, a title card — are the ones where
 * the arrangement *is* the content. Those were unmakeable here. A church who
 * wanted a gold rule under a heading, or their name small in the corner, had to
 * build it in something else and show a photograph of it.
 *
 * # What it is not
 *
 * Not a general drawing program, and not a second way to do things that already
 * work. There are four kinds of element because a church slide is four things:
 * words, a verse, a shape to divide or tint, and a picture. Anything a service
 * needs beyond that — a table of figures, a sermon's points — is a component
 * slide and is generated better than it could be drawn.
 *
 * # The canvas is the output
 *
 * It renders through `DesignedView`, which is the same component the wall uses,
 * against the same 16:9 frame and the deck's real background. What is on this
 * canvas is what the congregation gets; the only thing the editor adds is the
 * boxes you grab.
 */
export function DeckEditor({
  item,
  theme: churchTheme,
  translation,
  onClose,
  onSaved,
  onError,
}: {
  /** The deck to edit. A new one comes from `blankDeck`. */
  item: Item;
  theme: ProjectorTheme;
  /** Which Bible a scripture element resolves against. */
  translation: string;
  onClose: () => void;
  onSaved: (saved: Item) => void;
  onError: (message: string) => void;
}) {
  const deck = item.body.kind === "deck" ? item.body : null;

  const [title, setTitle] = useState(item.title);
  /*
   * The pages, with anything arranged laid out where the engine had it.
   *
   * `promote` does that once, on open, and the whole point of it is that a
   * generated deck opens looking like the deck the operator saw on the wall --
   * the hanging rules, the panels, the cards, the table's hairlines, at the
   * same sizes. From here on the slide is drawn by the studio's own renderer
   * on every surface, so what is on this canvas is exactly what goes up.
   */
  const [pages, setPages] = useState<SongSection[]>(() =>
    (deck?.sections ?? []).map((section, index) => ({
      ...section,
      label: section.label || `Page ${index + 1}`,
      elements: promote(section, churchTheme),
    })),
  );
  const [background, setBackground] = useState<Background>(
    deck?.background ?? DEFAULT_BACKGROUND,
  );
  const [at, setAt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [shapes, setShapes] = useState(false);

  const canvas = useRef<HTMLDivElement>(null);
  /** What is being typed, kept out of state so the caret survives a render. */
  const draft = useRef("");

  const theme = withBackground(churchTheme, background);
  const page = pages[at] ?? pages[0];
  const elements = page?.elements ?? [];
  const chosen = elements.find((element) => element.id === selected) ?? null;

  const edit = useCallback(
    (change: (elements: SlideElement[]) => SlideElement[]) => {
      setPages((current) =>
        current.map((section, index) =>
          index === at
            ? { ...section, elements: change(section.elements ?? []) }
            : section,
        ),
      );
    },
    [at],
  );

  const change = useCallback(
    (id: string, patch: (element: SlideElement) => SlideElement) => {
      edit((all) => all.map((element) => (element.id === id ? patch(element) : element)));
    },
    [edit],
  );

  /** Adds an element, selects it, and leaves it where the eye already is. */
  const add = useCallback(
    (element: SlideElement) => {
      edit((all) => [...all, element]);
      setSelected(element.id);
    },
    [edit],
  );

  const removeElement = useCallback(
    (id: string) => {
      edit((all) => all.filter((element) => element.id !== id));
      setSelected(null);
      setEditing(null);
    },
    [edit],
  );

  /*
   * Delete and Escape, which a canvas has to answer.
   *
   * Nothing here reaches the wall: the editor marks itself as a dialogue, so
   * `handsAreBusy` stands the transport's own arrow keys down while it is open
   * — an operator nudging an element must not step the live deck.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA";

      if (event.key === "Escape") {
        if (editing) return; // the editable box handles its own Escape
        setSelected(null);
        return;
      }
      if (typing || !selected) return;

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        removeElement(selected);
        return;
      }

      const nudge = event.shiftKey ? 1 : 10;
      const move =
        event.key === "ArrowLeft"
          ? { x: -nudge }
          : event.key === "ArrowRight"
            ? { x: nudge }
            : event.key === "ArrowUp"
              ? { y: -nudge }
              : event.key === "ArrowDown"
                ? { y: nudge }
                : null;
      if (!move) return;
      event.preventDefault();
      change(selected, (element) =>
        within({
          ...element,
          x: element.x + (move.x ?? 0),
          y: element.y + (move.y ?? 0),
        }),
      );
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, editing, removeElement, change]);

  /**
   * Dragging, in canvas units rather than screen pixels.
   *
   * The scale is measured at the moment the drag starts, so it is correct at
   * any zoom and on any window width, and `within` keeps an element from being
   * dragged somewhere only the inspector could retrieve it from.
   */
  const drag = (
    event: React.PointerEvent,
    element: SlideElement,
    what: "move" | "resize",
  ) => {
    event.stopPropagation();
    event.preventDefault();
    setSelected(element.id);
    if (editing === element.id) return;

    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const scale = CANVAS.width / rect.width;
    const from = {
      px: event.clientX,
      py: event.clientY,
      x: element.x,
      y: element.y,
      w: element.w,
      h: element.h,
    };

    const move = (moved: PointerEvent) => {
      const dx = (moved.clientX - from.px) * scale;
      const dy = (moved.clientY - from.py) * scale;
      change(element.id, (current) =>
        within(
          what === "move"
            ? { ...current, x: from.x + dx, y: from.y + dy }
            : { ...current, w: from.w + dx, h: from.h + dy },
        ),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Looks a reference up in the library and keeps the words it gives back. */
  const resolve = async (id: string, reference: string) => {
    const asked = reference.trim();
    change(id, (element) =>
      element.kind === "scripture" ? { ...element, reference: asked } : element,
    );
    if (!asked || !translation) return;
    try {
      const found = await scriptureIn(translation, asked);
      change(id, (element) =>
        element.kind === "scripture"
          ? {
              ...element,
              // The caption the library resolved, so "jn 3 16" becomes
              // "John 3:16" on the slide.
              reference: found.caption || asked,
              lines: found.lines.map((line) => line.text),
              translation: found.caption ? translation : "",
            }
          : element,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFile = async (what: "image" | "video") => {
    const chosenPath = await open({
      multiple: false,
      filters: [
        what === "image"
          ? { name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }
          : { name: "Clips", extensions: ["mp4", "mov", "m4v", "webm"] },
      ],
    });
    return typeof chosenPath === "string" ? chosenPath : null;
  };

  const save = async () => {
    const named = title.trim();
    if (!named) return;
    setSaving(true);
    try {
      const saved = await catalogSave({
        ...item,
        title: named,
        body: {
          kind: "deck",
          sections: pages.map((section) => ({
            label: section.label,
            /*
             * Lines are kept in step with what is on the slide.
             *
             * Everything that reads a deck as plain text reads these: the
             * library's search, a plan entry's label, an older surface that
             * predates elements. A designed slide whose lines still said what
             * it used to say would be findable by the wrong words.
             */
            lines: (section.elements ?? [])
              .map((element) =>
                element.kind === "text"
                  ? element.text
                  : element.kind === "scripture"
                    ? element.lines.join(" ")
                    : "",
              )
              .filter((text) => text.trim().length > 0),
            elements: section.elements ?? [],
            /*
             * Components are dropped, on purpose.
             *
             * A page that has been laid out has one layout, and keeping the
             * arrangement it grew from would leave two descriptions of the same
             * slide for the next reader to reconcile. `toLiveContent` prefers
             * elements, so keeping them would change nothing visible and would
             * be a lie sitting in the database.
             */
            components: undefined,
            layout: undefined,
          })),
          background,
        },
      });
      onSaved(saved);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      // Marked as a dialogue so every global shortcut stands down: the arrow
      // keys belong to the canvas while this is open.
      data-dialog
      className="fixed inset-0 z-50 flex flex-col bg-pulpitry-ink"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-pulpitry-line bg-pulpitry-surface px-3">
        <input
          value={title}
          placeholder="Name this deck"
          aria-label="Deck name"
          autoFocus={!title}
          onChange={(event) => setTitle(event.target.value)}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1.5 text-[15px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted hover:border-pulpitry-line focus-visible:focus-ring"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!title.trim() || saving}
          title={title.trim() ? "Keep this deck" : "Name it first"}
          className="rounded bg-pulpitry-gold px-3.5 py-2 text-[13px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onClose} className={BUTTON}>
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* The pages, drawn as they will appear. */}
        <div className="w-[13.5rem] shrink-0 overflow-auto border-r border-pulpitry-line p-2">
          {pages.map((section, index) => (
            <div key={index} className="mb-2 flex items-start gap-2">
              <span className="w-4 shrink-0 pt-6 text-[12px] text-pulpitry-muted tabular-nums">
                {index + 1}
              </span>
              <button
                type="button"
                onClick={() => {
                  setAt(index);
                  setSelected(null);
                  setEditing(null);
                }}
                className={`min-w-0 flex-1 rounded border p-1 text-left focus-visible:focus-ring ${
                  index === at
                    ? "border-pulpitry-teal bg-pulpitry-teal-dim/40"
                    : "border-transparent hover:border-pulpitry-line"
                }`}
              >
                <span
                  className="relative block w-full overflow-hidden rounded-sm [container-type:size]"
                  style={{ aspectRatio: 16 / 9 }}
                >
                  <Backdrop theme={theme} playVideo={false} />
                  <DesignedView
                    elements={section.elements ?? []}
                    theme={theme}
                  />
                </span>
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              setPages((current) => [
                ...current,
                {
                  label: `Page ${current.length + 1}`,
                  lines: [],
                  elements: [newText("Title")],
                },
              ]);
              setAt(pages.length);
              setSelected(null);
            }}
            className={`w-full ${BUTTON}`}
          >
            + Add new page
          </button>
        </div>

        {/* The canvas. */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-pulpitry-ink">
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 border-b border-pulpitry-line px-2 py-2">
            <span className="mr-1 text-[11px] tracking-[0.1em] text-pulpitry-muted uppercase">
              Add
            </span>
            <button type="button" onClick={() => add(newText())} className={BUTTON}>
              Text
            </button>
            <button
              type="button"
              onClick={() => add(newScripture())}
              title="A verse, looked up in the library and kept with the slide"
              className={BUTTON}
            >
              Scripture
            </button>
            <span className="relative">
              <button
                type="button"
                onClick={() => setShapes(!shapes)}
                aria-expanded={shapes}
                className={`${BUTTON} inline-flex items-center gap-1.5`}
              >
                <ShapeGlyph shape="rounded" />
                Shape ▾
              </button>
              {shapes ? (
                /* Two columns of shape and name. The drawing is how somebody
                   picks; the name is how they are sure, and how anybody using
                   a screen reader picks at all. */
                <span className="absolute top-full left-0 z-10 mt-1 grid w-[19rem] grid-cols-2 gap-0.5 rounded border border-pulpitry-line bg-pulpitry-surface p-1">
                  {SHAPES.map((shape) => (
                    <button
                      key={shape}
                      type="button"
                      onClick={() => {
                        add(newShape(shape));
                        setShapes(false);
                      }}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-pulpitry-text hover:bg-pulpitry-raised focus-visible:focus-ring"
                    >
                      <ShapeGlyph shape={shape} />
                      {SHAPE_LABELS[shape]}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => add(newTable())}
              title="A comparison, a rota, or a set of figures"
              className={BUTTON}
            >
              Table
            </button>
            <button
              type="button"
              onClick={() => {
                void pickFile("image").then((path) => path && add(newImage(path)));
              }}
              className={BUTTON}
            >
              Image
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div
              className="mx-auto"
              style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? "100%" : "none" }}
            >
              <div
                ref={canvas}
                onPointerDown={() => {
                  setSelected(null);
                  setEditing(null);
                }}
                className="relative w-full overflow-hidden rounded border border-pulpitry-line [container-type:size]"
                style={{ aspectRatio: 16 / 9 }}
              >
                {/* Moving, unlike the page list beside it. A motion or video
                    background is chosen by how it moves, and a still frame of
                    one tells the operator nothing about what the congregation
                    will be looking at for twenty minutes. */}
                <Backdrop theme={theme} />

                {/* The output, exactly as the wall draws it. */}
                <DesignedView elements={elements} theme={theme} hide={editing} />

                {/* Everything the editor adds: the boxes you grab. */}
                {elements.map((element) => {
                  const isChosen = element.id === selected;
                  const isEditing = element.id === editing;

                  return (
                    <div
                      key={element.id}
                      className="absolute"
                      style={boxStyle(element)}
                    >
                      {isEditing && element.kind === "text" ? (
                        <div
                          ref={(node) => {
                            if (node && document.activeElement !== node) {
                              draft.current = element.text;
                              node.focus();
                            }
                          }}
                          role="textbox"
                          tabIndex={0}
                          aria-label="Slide text"
                          contentEditable="plaintext-only"
                          suppressContentEditableWarning
                          onInput={(event) => {
                            draft.current = event.currentTarget.textContent ?? "";
                          }}
                          onBlur={() => {
                            const text = draft.current;
                            change(element.id, (current) =>
                              current.kind === "text"
                                ? { ...current, text }
                                : current,
                            );
                            setEditing(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          }}
                          className="h-full w-full outline-none ring-1 ring-pulpitry-teal"
                          style={{
                            ...typeStyle(element, theme),
                            whiteSpace: "pre-wrap",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent:
                              element.vertical === "top"
                                ? "flex-start"
                                : element.vertical === "bottom"
                                  ? "flex-end"
                                  : "center",
                          }}
                        >
                          {element.text}
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label={`Select ${element.kind}`}
                            onPointerDown={(event) => drag(event, element, "move")}
                            onDoubleClick={() => {
                              if (element.kind === "text") {
                                draft.current = element.text;
                                setEditing(element.id);
                              }
                            }}
                            className={`h-full w-full cursor-move rounded-none focus-visible:focus-ring ${
                              isChosen
                                ? "ring-1 ring-pulpitry-teal"
                                : "hover:ring-1 hover:ring-pulpitry-line"
                            }`}
                          />
                          {isChosen ? (
                            /* One handle, at the corner a hand expects. Width
                               and height are also typed into the inspector,
                               which is the precise way; this is the quick one. */
                            <span
                              onPointerDown={(event) => drag(event, element, "resize")}
                              className="absolute -right-1 -bottom-1 h-3 w-3 cursor-nwse-resize rounded-sm border border-pulpitry-ink bg-pulpitry-teal"
                            />
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-center gap-2 border-t border-pulpitry-line px-3 py-2">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
              aria-label="Smaller"
              className={BUTTON}
            >
              −
            </button>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={zoom}
              aria-label="Zoom"
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-40 accent-pulpitry-teal"
            />
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(2, Number((z + 0.1).toFixed(2))))}
              aria-label="Larger"
              className={BUTTON}
            >
              +
            </button>
            <span className="w-10 text-right text-[11px] text-pulpitry-muted tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
          </div>
        </div>

        {/* The inspector. */}
        <div className="w-[20rem] shrink-0 overflow-auto border-l border-pulpitry-line bg-pulpitry-surface">
          <Collapsible title="Page" note="This slide">
            <label className="block">
              <span className="mb-1 block text-[11px] text-pulpitry-muted">
                Name — how it is listed, never shown
              </span>
              <input
                value={page?.label ?? ""}
                onChange={(event) =>
                  setPages((current) =>
                    current.map((section, index) =>
                      index === at
                        ? { ...section, label: event.target.value }
                        : section,
                    ),
                  )
                }
                className={FIELD}
              />
            </label>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setPages((current) => {
                    const copy = current[at];
                    if (!copy) return current;
                    const next = [...current];
                    next.splice(at + 1, 0, {
                      ...copy,
                      label: `${copy.label} copy`,
                      elements: (copy.elements ?? []).map(reidentify),
                    });
                    return next;
                  });
                  setAt(at + 1);
                  setSelected(null);
                }}
                className={`flex-1 ${BUTTON}`}
              >
                Duplicate
              </button>
              <button
                type="button"
                disabled={pages.length <= 1}
                onClick={() => {
                  setPages((current) => current.filter((_, index) => index !== at));
                  setAt(Math.max(0, at - 1));
                  setSelected(null);
                }}
                title={
                  pages.length <= 1
                    ? "A deck has to have a page in it"
                    : "Remove this page"
                }
                className={`flex-1 ${BUTTON}`}
              >
                Delete
              </button>
            </div>
          </Collapsible>

          {chosen ? (
            <>
              <Collapsible title="Content">
                {chosen.kind === "text" ? (
                  <textarea
                    value={chosen.text}
                    rows={4}
                    aria-label="Text"
                    onChange={(event) =>
                      change(chosen.id, (element) =>
                        element.kind === "text"
                          ? { ...element, text: event.target.value }
                          : element,
                      )
                    }
                    className={FIELD}
                  />
                ) : null}

                {chosen.kind === "scripture" ? (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-pulpitry-muted">
                        Reference — looked up in {translation || "your Bible"}
                      </span>
                      <input
                        value={chosen.reference}
                        placeholder="John 3:16"
                        onChange={(event) =>
                          change(chosen.id, (element) =>
                            element.kind === "scripture"
                              ? { ...element, reference: event.target.value }
                              : element,
                          )
                        }
                        onBlur={(event) => void resolve(chosen.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void resolve(chosen.id, chosen.reference);
                          }
                        }}
                        className={FIELD}
                      />
                    </label>
                    <p className="text-[11px] leading-relaxed text-pulpitry-muted">
                      {chosen.lines.length > 0
                        ? "The words are kept with the slide, so it reads the same next month."
                        : "Press Enter to look it up."}
                    </p>
                    <label className="flex items-center gap-2 text-[12px] text-pulpitry-text">
                      <input
                        type="checkbox"
                        checked={chosen.showReference}
                        onChange={(event) =>
                          change(chosen.id, (element) =>
                            element.kind === "scripture"
                              ? { ...element, showReference: event.target.checked }
                              : element,
                          )
                        }
                        className="h-3.5 w-3.5 accent-pulpitry-teal"
                      />
                      Show the reference under it
                    </label>
                  </>
                ) : null}

                {chosen.kind === "image" ? (
                  <>
                    <p className="truncate text-[11px] text-pulpitry-muted" title={chosen.path}>
                      {chosen.path.split("/").pop()}
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          void pickFile("image").then(
                            (path) =>
                              path &&
                              change(chosen.id, (element) =>
                                element.kind === "image"
                                  ? { ...element, path }
                                  : element,
                              ),
                          );
                        }}
                        className={`flex-1 ${BUTTON}`}
                      >
                        Replace
                      </button>
                      <Segment
                        label="Fit"
                        value={chosen.fit}
                        options={[
                          ["cover", "Fill", "Crop it to the box"],
                          ["contain", "Whole", "Fit it all inside the box"],
                        ]}
                        onChange={(fit) =>
                          change(chosen.id, (element) =>
                            element.kind === "image" ? { ...element, fit } : element,
                          )
                        }
                      />
                    </div>
                  </>
                ) : null}

                {chosen.kind === "table" ? (
                  <TableFields
                    element={chosen}
                    onChange={(patch) =>
                      change(chosen.id, (element) =>
                        element.kind === "table"
                          ? { ...element, ...patch }
                          : element,
                      )
                    }
                  />
                ) : null}

                {chosen.kind === "shape" ? (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-pulpitry-muted">
                        Shape
                      </span>
                      <select
                        value={chosen.shape}
                        onChange={(event) =>
                          change(chosen.id, (element) =>
                            element.kind === "shape"
                              ? {
                                  ...element,
                                  shape: event.target.value as ShapeKind,
                                }
                              : element,
                          )
                        }
                        className={FIELD}
                      >
                        {SHAPES.map((shape) => (
                          <option key={shape} value={shape}>
                            {SHAPE_LABELS[shape]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Colour
                      label="Fill"
                      value={chosen.fill}
                      opacity={chosen.opacity}
                      onChange={(fill) =>
                        change(chosen.id, (element) =>
                          element.kind === "shape" ? { ...element, fill } : element,
                        )
                      }
                      onOpacity={(opacity) =>
                        change(chosen.id, (element) =>
                          element.kind === "shape" ? { ...element, opacity } : element,
                        )
                      }
                    />
                    {/* Only the shapes that have corners to round. */}
                    {chosen.shape === "rounded" || chosen.shape === "line" ? (
                      <NumberField
                        label="Corner rounding"
                        value={chosen.radius}
                        min={0}
                        onChange={(radius) =>
                          change(chosen.id, (element) =>
                            element.kind === "shape" ? { ...element, radius } : element,
                          )
                        }
                      />
                    ) : null}
                  </>
                ) : null}
              </Collapsible>

              <Collapsible title="Element" note="Actions">
                <button
                  type="button"
                  onClick={() => removeElement(chosen.id)}
                  className={`w-full ${BUTTON}`}
                >
                  Delete
                </button>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    title="Bring it in front of the others"
                    onClick={() =>
                      edit((all) => [
                        ...all.filter((element) => element.id !== chosen.id),
                        chosen,
                      ])
                    }
                    className={`flex-1 ${BUTTON}`}
                  >
                    To front
                  </button>
                  <button
                    type="button"
                    title="Send it behind the others"
                    onClick={() =>
                      edit((all) => [
                        chosen,
                        ...all.filter((element) => element.id !== chosen.id),
                      ])
                    }
                    className={`flex-1 ${BUTTON}`}
                  >
                    To back
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => add(reidentify(within({ ...chosen, y: chosen.y + 40 })))}
                  className={`w-full ${BUTTON}`}
                >
                  Duplicate
                </button>
              </Collapsible>

              {isTypeset(chosen) ? (
                <Collapsible title="Text">
                  <label className="block">
                    <span className="mb-1 block text-[11px] text-pulpitry-muted">
                      Font
                    </span>
                    <select
                      value={chosen.font}
                      onChange={(event) =>
                        change(chosen.id, (element) =>
                          isTypeset(element)
                            ? { ...element, font: event.target.value }
                            : element,
                        )
                      }
                      className={FIELD}
                    >
                      <option value="">The church's own ({churchTheme.fontFamily})</option>
                      {FONT_FAMILIES.map((family) => (
                        <option key={family.key} value={family.key}>
                          {family.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="flex gap-1.5">
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[11px] text-pulpitry-muted">
                        Weight
                      </span>
                      <select
                        value={chosen.weight}
                        onChange={(event) =>
                          change(chosen.id, (element) =>
                            isTypeset(element)
                              ? { ...element, weight: Number(event.target.value) }
                              : element,
                          )
                        }
                        className={FIELD}
                      >
                        {[300, 400, 500, 600, 700, 800, 900].map((weight) => (
                          <option key={weight} value={weight}>
                            {weight}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NumberField
                      label="Size"
                      value={chosen.size}
                      min={8}
                      max={600}
                      onChange={(size) =>
                        change(chosen.id, (element) =>
                          isTypeset(element) ? { ...element, size } : element,
                        )
                      }
                    />
                  </div>

                  <div className="flex gap-1.5">
                    <NumberField
                      label="Line height"
                      value={chosen.lineHeight}
                      step={0.01}
                      min={0.7}
                      max={3}
                      onChange={(lineHeight) =>
                        change(chosen.id, (element) =>
                          isTypeset(element) ? { ...element, lineHeight } : element,
                        )
                      }
                    />
                    <NumberField
                      label="Letter spacing"
                      value={chosen.letterSpacing}
                      onChange={(letterSpacing) =>
                        change(chosen.id, (element) =>
                          isTypeset(element)
                            ? { ...element, letterSpacing }
                            : element,
                        )
                      }
                    />
                  </div>

                  <Colour
                    label="Colour"
                    value={chosen.color}
                    opacity={chosen.opacity}
                    onChange={(color) =>
                      change(chosen.id, (element) =>
                        isTypeset(element) ? { ...element, color } : element,
                      )
                    }
                    onOpacity={(opacity) =>
                      change(chosen.id, (element) =>
                        isTypeset(element) ? { ...element, opacity } : element,
                      )
                    }
                  />

                  <div className="flex gap-1.5">
                    <Segment<Typeset["align"]>
                      label="Alignment"
                      value={chosen.align}
                      options={[
                        ["left", "◧", "Left"],
                        ["center", "▣", "Centred"],
                        ["right", "◨", "Right"],
                      ]}
                      onChange={(align) =>
                        change(chosen.id, (element) =>
                          isTypeset(element) ? { ...element, align } : element,
                        )
                      }
                    />
                    <Segment<Typeset["vertical"]>
                      label="Vertical"
                      value={chosen.vertical}
                      options={[
                        ["top", "⤒", "Top of the box"],
                        ["middle", "✳", "Middle"],
                        ["bottom", "⤓", "Bottom"],
                      ]}
                      onChange={(vertical) =>
                        change(chosen.id, (element) =>
                          isTypeset(element) ? { ...element, vertical } : element,
                        )
                      }
                    />
                  </div>

                  <div className="flex gap-1.5">
                    <Segment<"none" | "underline" | "strike">
                      label="Decoration"
                      value={
                        chosen.underline
                          ? "underline"
                          : chosen.strike
                            ? "strike"
                            : "none"
                      }
                      options={[
                        ["none", "—", "Plain"],
                        ["underline", "U", "Underlined"],
                        ["strike", "S", "Struck through"],
                      ]}
                      onChange={(how) =>
                        change(chosen.id, (element) =>
                          isTypeset(element)
                            ? {
                                ...element,
                                underline: how === "underline",
                                strike: how === "strike",
                              }
                            : element,
                        )
                      }
                    />
                    <Segment<Typeset["textCase"]>
                      label="Case"
                      value={chosen.textCase}
                      options={[
                        ["none", "—", "As written"],
                        ["upper", "AB", "CAPITALS"],
                        ["title", "Ab", "Title Case"],
                        ["lower", "ab", "lower case"],
                      ]}
                      onChange={(textCase) =>
                        change(chosen.id, (element) =>
                          isTypeset(element) ? { ...element, textCase } : element,
                        )
                      }
                    />
                  </div>
                </Collapsible>
              ) : null}

              <Collapsible title="Layout" note="Where it sits on the slide">
                <div className="flex gap-1.5">
                  <NumberField
                    label="X"
                    value={chosen.x}
                    onChange={(x) =>
                      change(chosen.id, (element) => within({ ...element, x }))
                    }
                  />
                  <NumberField
                    label="Y"
                    value={chosen.y}
                    onChange={(y) =>
                      change(chosen.id, (element) => within({ ...element, y }))
                    }
                  />
                </div>
                <div className="flex gap-1.5">
                  <NumberField
                    label="Width"
                    value={chosen.w}
                    onChange={(w) =>
                      change(chosen.id, (element) => within({ ...element, w }))
                    }
                  />
                  <NumberField
                    label="Height"
                    value={chosen.h}
                    onChange={(h) =>
                      change(chosen.id, (element) => within({ ...element, h }))
                    }
                  />
                </div>
                <p className="text-[11px] leading-relaxed text-pulpitry-muted">
                  Measured against {CANVAS.width} × {CANVAS.height}, so a deck
                  looks the same on any screen.
                </p>
              </Collapsible>
            </>
          ) : (
            <p className="border-b border-pulpitry-line px-3 py-3 text-[11.5px] leading-relaxed text-pulpitry-muted">
              Click something on the slide to change it. Double-click text to
              type on the slide itself.
            </p>
          )}

          <Collapsible title="Background" note="All slides in this deck">
            <label className="block">
              <span className="mb-1 block text-[11px] text-pulpitry-muted">
                Background type
              </span>
              <select
                value={background.backgroundKind}
                onChange={(event) =>
                  setBackground({
                    ...background,
                    backgroundKind: event.target
                      .value as Background["backgroundKind"],
                  })
                }
                className={FIELD}
              >
                <option value="color">Solid colour</option>
                <option value="gradient">Gradient</option>
                <option value="image">Picture</option>
                <option value="video">Clip</option>
                <option value="motion">Motion</option>
              </select>
            </label>

            {background.backgroundKind === "color" ? (
              <Colour
                label="Colour"
                value={background.backgroundColor}
                onChange={(backgroundColor) =>
                  setBackground({ ...background, backgroundColor })
                }
              />
            ) : null}

            {background.backgroundKind === "gradient" ||
            background.backgroundKind === "motion" ? (
              <>
                <div className="flex gap-1.5">
                  <div className="min-w-0 flex-1">
                    <Colour
                      label="From"
                      value={background.gradientFrom}
                      onChange={(gradientFrom) =>
                        setBackground({ ...background, gradientFrom })
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Colour
                      label="To"
                      value={background.gradientTo}
                      onChange={(gradientTo) =>
                        setBackground({ ...background, gradientTo })
                      }
                    />
                  </div>
                </div>

                {background.backgroundKind === "gradient" ? (
                  <NumberField
                    label="Angle"
                    value={background.gradientAngle}
                    min={0}
                    max={360}
                    onChange={(gradientAngle) =>
                      setBackground({ ...background, gradientAngle })
                    }
                  />
                ) : null}

                {/* Ready-made pairs, because a gradient is two colours that
                    have to agree and picking them is a design job. */}
                <div className="grid grid-cols-2 gap-1.5">
                  {GRADIENT_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        setBackground({
                          ...background,
                          gradientFrom: preset.from,
                          gradientTo: preset.to,
                          gradientAngle: preset.angle,
                        })
                      }
                      className="rounded border border-pulpitry-line p-1 text-left hover:border-pulpitry-gold-dim focus-visible:focus-ring"
                    >
                      <span
                        className="block h-6 w-full rounded-sm"
                        style={{
                          background: `linear-gradient(${preset.angle}deg, ${preset.from}, ${preset.to})`,
                        }}
                      />
                      <span className="mt-1 block truncate text-[10.5px] text-pulpitry-muted">
                        {preset.label}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {background.backgroundKind === "motion" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11px] text-pulpitry-muted">
                    Movement — drawn here, so it stays sharp on any screen
                  </span>
                  <select
                    value={background.motion}
                    onChange={(event) =>
                      setBackground({ ...background, motion: event.target.value })
                    }
                    className={FIELD}
                  >
                    {MOTIONS.map((motion) => (
                      <option key={motion.key} value={motion.key}>
                        {motion.label}
                      </option>
                    ))}
                  </select>
                </label>
                <NumberField
                  label="Speed"
                  value={background.motionSpeed}
                  step={0.05}
                  min={0.1}
                  max={3}
                  onChange={(motionSpeed) =>
                    setBackground({ ...background, motionSpeed })
                  }
                />
              </>
            ) : null}

            {background.backgroundKind === "image" ||
            background.backgroundKind === "video" ? (
              <>
                <p
                  className="truncate text-[11px] text-pulpitry-muted"
                  title={background.backgroundPath ?? ""}
                >
                  {background.backgroundPath?.split("/").pop() ??
                    "Nothing chosen yet"}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void pickFile(
                      background.backgroundKind === "video" ? "video" : "image",
                    ).then(
                      (path) =>
                        path &&
                        setBackground({ ...background, backgroundPath: path }),
                    );
                  }}
                  className={`w-full ${BUTTON}`}
                >
                  Choose a {background.backgroundKind === "video" ? "clip" : "picture"}…
                </button>
                <Segment
                  label="Fit"
                  value={background.backgroundFit === "contain" ? "contain" : "cover"}
                  options={[
                    ["cover", "Fill", "Crop it to the screen"],
                    ["contain", "Whole", "Fit it all on the screen"],
                  ]}
                  onChange={(backgroundFit) =>
                    setBackground({ ...background, backgroundFit })
                  }
                />
                <label className="block">
                  <span className="mb-1 block text-[11px] text-pulpitry-muted">
                    Darken it, so words stay readable —{" "}
                    {Math.round(background.backgroundDim * 100)}%
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={0.85}
                    step={0.05}
                    value={background.backgroundDim}
                    onChange={(event) =>
                      setBackground({
                        ...background,
                        backgroundDim: Number(event.target.value),
                      })
                    }
                    className="w-full accent-pulpitry-teal"
                  />
                </label>
              </>
            ) : null}
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
