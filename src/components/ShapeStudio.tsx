import { useCallback, useEffect, useRef, useState } from "react";

import { open } from "@tauri-apps/plugin-dialog";

import { catalogRemove, catalogSave, newItem, type Item } from "../lib/catalog";
import {
  isTypeset,
  newImage,
  newShape,
  newText,
  reidentify,
  SHAPES,
  SHAPE_LABELS,
  within,
  type ShapeKind,
  type SlideElement,
  type Typeset,
} from "../lib/design";
import { filled, hasWords, newSlot, SAMPLE } from "../lib/shapes";
import { FONT_FAMILIES, type ProjectorTheme } from "../lib/theme";
import { useDragBox } from "../lib/useDragBox";
import { Swatch } from "./Controls";
import { boxStyle, DesignedView } from "./DesignedView";

const FIELD =
  "w-full rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

const BUTTON =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring";

const LABEL =
  "mb-1 block text-[10.5px] tracking-[0.08em] text-pulpitry-muted uppercase";

/**
 * The chequer behind the canvas.
 *
 * An overlay is keyed: what is not drawn is not there. A studio that drew it on
 * black would be lying about the one property that matters -- a church would
 * design a dark band on a dark ground, send it to a switcher, and discover the
 * band was the only part that existed. The chequer says "nothing here" the way
 * every image editor says it.
 */
const CHEQUER = {
  backgroundImage:
    "repeating-conic-gradient(#2a2a28 0% 25%, #1e1e1c 0% 50%)",
  backgroundSize: "24px 24px",
};

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="min-w-0 flex-1">
      <span className={LABEL}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className={FIELD}
      />
    </label>
  );
}

/**
 * Drawing the furniture an overlay output puts around the words.
 *
 * # Why it is not the slide studio
 *
 * They share their machinery -- the same elements, the same canvas, the same
 * dragging -- and they are different jobs, which is why this is its own screen.
 *
 * A slide is everything on the wall: it has a background, it fills the frame,
 * and what is on it is what somebody typed. A shape is the opposite of full: it
 * is a band and a rule and a logo, drawn on nothing, with two holes in it that
 * the live words fall into. So there is no background here, the ground is a
 * chequer rather than a colour, and two of the elements are *slots* whose text
 * is a stand-in for whatever goes live.
 *
 * # Why a church needs it at all
 *
 * Six built-in forms are six other churches' answers. A stream's furniture is
 * the most church-specific thing on any screen -- their proportions, their
 * colours, their logo, and a band shaped around a camera framing nobody else
 * has.
 */
export function ShapeStudio({
  shape,
  theme,
  onClose,
  onSaved,
  onError,
}: {
  /** An existing shape, or a new one carrying the starter elements. */
  shape: Item;
  /** The church's look, so slot text is drawn in the typeface they use. */
  theme: ProjectorTheme;
  onClose: () => void;
  onSaved: (saved: Item) => void;
  onError: (message: string) => void;
}) {
  const held = shape.body.kind === "overlay" ? shape.body.elements : [];

  const [name, setName] = useState(shape.title);
  const [elements, setElements] = useState<SlideElement[]>(held);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [shapesOpen, setShapesOpen] = useState(false);

  const canvas = useRef<HTMLDivElement>(null);
  const chosen = elements.find((element) => element.id === selected) ?? null;

  const change = useCallback(
    (id: string, patch: (element: SlideElement) => SlideElement) => {
      setElements((all) =>
        all.map((element) => (element.id === id ? patch(element) : element)),
      );
    },
    [],
  );

  const drag = useDragBox(canvas, (box) => {
    if (!selected) return;
    change(selected, (element) => ({ ...element, ...box }));
  });

  const add = (element: SlideElement) => {
    setElements((all) => [...all, element]);
    setSelected(element.id);
  };

  const remove = (id: string) => {
    setElements((all) => all.filter((element) => element.id !== id));
    setSelected(null);
  };

  // Delete and Escape, as the slide studio answers them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }
      if (event.key === "Escape") return setSelected(null);
      if (!selected) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        remove(selected);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  const save = async () => {
    const named = name.trim();
    if (!named || saving) return;
    setSaving(true);
    try {
      onSaved(
        await catalogSave({
          ...(shape.id === null
            ? newItem(named, { kind: "overlay", elements })
            : { ...shape, title: named, body: { kind: "overlay", elements } }),
        }),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const pickImage = async () => {
    const path = await open({
      multiple: false,
      filters: [
        { name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "avif"] },
      ],
    });
    if (typeof path === "string") add(newImage(path));
  };

  return (
    <div data-dialog className="fixed inset-0 z-50 flex flex-col bg-pulpitry-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-pulpitry-line bg-pulpitry-surface px-3">
        <input
          value={name}
          placeholder="Name this shape"
          aria-label="Shape name"
          autoFocus={!shape.title}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1.5 text-[15px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted hover:border-pulpitry-line focus-visible:focus-ring"
        />
        {shape.id !== null ? (
          <button
            type="button"
            onClick={() => {
              void catalogRemove(shape.id!)
                .then(onClose)
                .catch((err) =>
                  onError(err instanceof Error ? err.message : String(err)),
                );
            }}
            title="Remove this shape from the library"
            className={BUTTON}
          >
            Delete
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={BUTTON}>
          Close
        </button>
        <button
          type="button"
          disabled={!name.trim() || saving}
          onClick={() => void save()}
          title={name.trim() ? "Keep this shape" : "Name it first"}
          className="rounded bg-pulpitry-gold px-3.5 py-2 text-[13px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
        >
          {saving ? "Saving…" : "Save shape"}
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(21rem,0.42fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 border-b border-pulpitry-line px-2 py-2">
            <span className="mr-1 text-[11px] tracking-[0.1em] text-pulpitry-muted uppercase">
              Add
            </span>
            <button
              type="button"
              onClick={() => add(newSlot("words"))}
              title="The hole the live words drop into. A shape needs one."
              className={BUTTON}
            >
              Words
            </button>
            <button
              type="button"
              onClick={() => add(newSlot("reference"))}
              title="The hole the citation drops into — a reference, or a song's title"
              className={BUTTON}
            >
              Citation
            </button>
            <button type="button" onClick={() => add(newText("Your church"))} className={BUTTON}>
              Text
            </button>
            <span className="relative">
              <button
                type="button"
                onClick={() => setShapesOpen(!shapesOpen)}
                className={BUTTON}
              >
                Block ▾
              </button>
              {shapesOpen ? (
                <span className="absolute top-full left-0 z-10 mt-1 grid w-[16rem] grid-cols-2 gap-0.5 rounded border border-pulpitry-line bg-pulpitry-surface p-1">
                  {SHAPES.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => {
                        add(newShape(kind as ShapeKind));
                        setShapesOpen(false);
                      }}
                      className="rounded px-2 py-1.5 text-left text-[12px] text-pulpitry-text hover:bg-pulpitry-raised focus-visible:focus-ring"
                    >
                      {SHAPE_LABELS[kind]}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
            <button type="button" onClick={() => void pickImage()} className={BUTTON}>
              Logo
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div
              ref={canvas}
              onPointerDown={() => setSelected(null)}
              className="relative mx-auto w-full max-w-[min(100%,calc((100vh-14rem)*1.777))] overflow-hidden rounded border border-pulpitry-line [container-type:size]"
              style={{ aspectRatio: 16 / 9, ...CHEQUER }}
            >
              {/* The shape as it will be drawn, with the holes filled by the
                  sample so the boxes hold something the size of real words. */}
              <DesignedView
                elements={filled(elements, SAMPLE.words, SAMPLE.reference)}
                theme={theme}
              />

              {elements.map((element) => {
                const isChosen = element.id === selected;
                return (
                  <div key={element.id} className="absolute" style={boxStyle(element)}>
                    <button
                      type="button"
                      aria-label={`Select ${element.kind}`}
                      onPointerDown={(event) => {
                        setSelected(element.id);
                        drag(event, element, "move");
                      }}
                      className={`h-full w-full cursor-move focus-visible:focus-ring ${
                        isChosen
                          ? "ring-1 ring-pulpitry-teal"
                          : "hover:ring-1 hover:ring-pulpitry-line"
                      }`}
                    />
                    {isChosen ? (
                      <span
                        onPointerDown={(event) => drag(event, element, "resize")}
                        className="absolute -right-1 -bottom-1 h-3 w-3 cursor-nwse-resize rounded-sm border border-pulpitry-ink bg-pulpitry-teal"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>

            <p className="mx-auto mt-3 max-w-[46ch] text-center text-[11.5px] leading-relaxed text-pulpitry-muted">
              The chequer is nothing: an overlay is keyed, so whatever you do
              not draw is not there.
              {hasWords(elements)
                ? ""
                : " This shape has no Words box yet, so nothing live would appear in it."}
            </p>
          </div>
        </div>

        <div className="min-h-0 overflow-auto border-l border-pulpitry-line p-3">
          {!chosen ? (
            <p className="text-[11.5px] leading-relaxed text-pulpitry-muted">
              Click a part of the shape to change it. The Words box and the
              Citation box are filled when something goes live — what they say
              here is a stand-in, so you can see the size.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] text-pulpitry-text">
                  {chosen.kind === "text" && chosen.slot
                    ? chosen.slot === "words"
                      ? "The words"
                      : "The citation"
                    : chosen.kind === "text"
                      ? "Text"
                      : chosen.kind === "shape"
                        ? SHAPE_LABELS[chosen.shape]
                        : "Logo"}
                </span>
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => add(reidentify(within({ ...chosen, y: chosen.y + 30 })))}
                    className={BUTTON}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(chosen.id)}
                    className={BUTTON}
                  >
                    Delete
                  </button>
                </span>
              </div>

              {chosen.kind === "text" ? (
                <label className="block">
                  <span className={LABEL}>
                    {chosen.slot ? "Stand-in text, never shown" : "Text"}
                  </span>
                  <textarea
                    value={chosen.text}
                    rows={2}
                    onChange={(event) =>
                      change(chosen.id, (element) =>
                        element.kind === "text"
                          ? { ...element, text: event.target.value }
                          : element,
                      )
                    }
                    className={FIELD}
                  />
                </label>
              ) : null}

              {chosen.kind === "shape" ? (
                <Swatch
                  label="Fill"
                  value={chosen.fill}
                  onChange={(fill) =>
                    change(chosen.id, (element) =>
                      element.kind === "shape" ? { ...element, fill } : element,
                    )
                  }
                />
              ) : null}

              {isTypeset(chosen) ? (
                <>
                  <div className="flex gap-2">
                    <label className="min-w-0 flex-1">
                      <span className={LABEL}>Font</span>
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
                        <option value="">The church&apos;s own</option>
                        {FONT_FAMILIES.map((family) => (
                          <option key={family.key} value={family.key}>
                            {family.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NumberField
                      label="Size"
                      value={chosen.size}
                      min={8}
                      max={300}
                      onChange={(size) =>
                        change(chosen.id, (element) =>
                          isTypeset(element) ? { ...element, size } : element,
                        )
                      }
                    />
                  </div>

                  <Swatch
                    label="Colour"
                    value={chosen.color}
                    onChange={(color) =>
                      change(chosen.id, (element) =>
                        isTypeset(element) ? { ...element, color } : element,
                      )
                    }
                  />

                  <div className="flex gap-2">
                    <label className="min-w-0 flex-1">
                      <span className={LABEL}>Align</span>
                      <select
                        value={chosen.align}
                        onChange={(event) =>
                          change(chosen.id, (element) =>
                            isTypeset(element)
                              ? {
                                  ...element,
                                  align: event.target
                                    .value as Typeset["align"],
                                }
                              : element,
                          )
                        }
                        className={FIELD}
                      >
                        <option value="left">Left</option>
                        <option value="center">Centre</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                    <label className="min-w-0 flex-1">
                      <span className={LABEL}>In its box</span>
                      <select
                        value={chosen.vertical}
                        onChange={(event) =>
                          change(chosen.id, (element) =>
                            isTypeset(element)
                              ? {
                                  ...element,
                                  vertical: event.target
                                    .value as Typeset["vertical"],
                                }
                              : element,
                          )
                        }
                        className={FIELD}
                      >
                        <option value="top">Top</option>
                        <option value="middle">Middle</option>
                        <option value="bottom">Bottom</option>
                      </select>
                    </label>
                  </div>
                </>
              ) : null}

              <div className="flex gap-2">
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
              <div className="flex gap-2">
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
                Measured against 1920 × 1080, so a shape holds its proportions
                on any output it is put on.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
