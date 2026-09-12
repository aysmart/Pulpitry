import { useCallback, useEffect, useState } from "react";

import { catalogRemove, newItem, type Item } from "../lib/catalog";
import { OVERLAY_FORMS, type OverlayForm } from "../lib/overlays";
import {
  filled,
  listShapes,
  SAMPLE,
  shapeFromForm,
  starterShape,
} from "../lib/shapes";
import { SHAPE_TEMPLATES } from "../lib/shapeTemplates";
import type { ProjectorTheme } from "../lib/theme";
import { DesignedView } from "./DesignedView";
import { OverlayView } from "./OverlayView";
import { ShapeStudio } from "./ShapeStudio";

const BUTTON =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12.5px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring";

/**
 * The chequer, which is the point: an overlay is keyed, and whatever is not
 * drawn is not there. The same ground the studio uses, so a shape looks the
 * same in the list as it did while it was being drawn.
 */
const CHEQUER = {
  backgroundImage: "repeating-conic-gradient(#2a2a28 0% 25%, #1e1e1c 0% 50%)",
  backgroundSize: "18px 18px",
};

/**
 * Every display shape the church has drawn.
 *
 * # Why a library rather than a menu on an output
 *
 * A shape is a thing a church owns, not a setting on one screen. They draw a
 * lower third for the stream, a wider one for the foyer panel, a corner card
 * for the notices — and then they have three of them, used by different
 * outputs on different Sundays, wanted in a different order next month.
 * Reached only from an output's own picker, a shape could be edited only by
 * first pointing something at it, and a shape nothing currently uses could not
 * be found at all.
 *
 * So: the same shape as the Looks screen, for the same reason. Each one drawn
 * at the size it will be seen, on the ground it will be keyed against, with the
 * sample words in its holes — because a shape is chosen by looking at it, and a
 * list of names tells nobody which one has the logo in it.
 */
export function ShapeLibrary({
  theme,
  onClose,
  onError,
}: {
  /** The church's look, so slot text is drawn in the typeface they use. */
  theme: ProjectorTheme;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [shapes, setShapes] = useState<Item[]>([]);
  const [designing, setDesigning] = useState<Item | null>(null);

  const refresh = useCallback(() => {
    void listShapes()
      .then(setShapes)
      .catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [onError]);

  useEffect(refresh, [refresh]);

  if (designing) {
    return (
      <ShapeStudio
        shape={designing}
        theme={theme}
        onClose={() => {
          setDesigning(null);
          refresh();
        }}
        onSaved={() => {
          /*
           * Back to the library rather than to an output.
           *
           * Opened from an output, saving points that output at what was just
           * drawn -- the operator was answering a question about that screen.
           * Opened from here they were not: they were working on the shape
           * itself, and assigning it to something would be a decision nobody
           * asked for.
           */
          setDesigning(null);
          refresh();
        }}
        onError={onError}
      />
    );
  }

  return (
    <div data-dialog className="fixed inset-0 z-50 flex flex-col bg-pulpitry-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-pulpitry-line bg-pulpitry-surface px-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] text-pulpitry-text">
            Display shapes
          </span>
          <span className="block text-[11.5px] text-pulpitry-muted">
            The furniture an output draws around the words — a band, a rule,
            your logo
          </span>
        </span>
        <button
          type="button"
          onClick={() =>
            setDesigning(
              newItem("", { kind: "overlay", elements: starterShape() }),
            )
          }
          className={BUTTON}
        >
          New shape
        </button>
        <button type="button" onClick={onClose} className={BUTTON}>
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {shapes.length > 0 ? (
          <p className="mb-2 text-[11px] tracking-wide text-pulpitry-muted uppercase">
            Yours
          </p>
        ) : null}

        {shapes.length > 0 ? (
          <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
            {shapes.map((shape) => (
              <div key={shape.id} className="group relative flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setDesigning(shape)}
                  title={`Change ${shape.title}`}
                  className="block text-left focus-visible:focus-ring"
                >
                  <span
                    className="relative block w-full overflow-hidden rounded border border-pulpitry-line [container-type:size]"
                    style={{ aspectRatio: 16 / 9, ...CHEQUER }}
                  >
                    {shape.body.kind === "overlay" ? (
                      <DesignedView
                        elements={filled(
                          shape.body.elements,
                          SAMPLE.words,
                          SAMPLE.reference,
                        )}
                        theme={theme}
                      />
                    ) : null}
                  </span>
                  <span className="mt-1.5 block truncate text-[12.5px] text-pulpitry-text">
                    {shape.title}
                  </span>
                  <span className="block truncate text-[11px] text-pulpitry-muted">
                    {shape.body.kind === "overlay"
                      ? `${shape.body.elements.length} ${
                          shape.body.elements.length === 1 ? "part" : "parts"
                        }`
                      : ""}
                  </span>
                </button>

                {/* On hover, as everywhere else a library row can be removed:
                    a column of crosses is noise in a list that is read far
                    more often than it is edited. */}
                <button
                  type="button"
                  onClick={() => {
                    if (shape.id === null) return;
                    void catalogRemove(shape.id)
                      .then(refresh)
                      .catch((err) =>
                        onError(
                          err instanceof Error ? err.message : String(err),
                        ),
                      );
                  }}
                  aria-label={`Remove ${shape.title}`}
                  className="absolute top-1 right-1 hidden rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[12px] leading-none text-pulpitry-muted hover:text-pulpitry-text group-hover:block focus-visible:focus-ring"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/*
          The shipped ones, and they are shapes rather than a second kind of
          thing.

          They were the six built-in forms drawn by the renderer, which meant
          the library showed something a church could look at and not have. A
          template is made of the same elements a shape drawn by hand is made
          of, so the tile is exactly what a copy will be -- and the first thing
          most churches do to any of them is move the band and drop a logo in
          it, which is a drag rather than a request.
        */}
        <p className="mb-2 text-[11px] tracking-wide text-pulpitry-muted uppercase">
          Templates
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
          {SHAPE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() =>
                setDesigning(
                  newItem(template.name, {
                    kind: "overlay",
                    elements: template.elements,
                  }),
                )
              }
              title={`${template.hint} Opens a copy of your own.`}
              className="group flex flex-col gap-1 text-left focus-visible:focus-ring"
            >
              <span
                className="relative block w-full overflow-hidden rounded border border-pulpitry-line ring-pulpitry-teal group-hover:ring-2 [container-type:size]"
                style={{ aspectRatio: 16 / 9, ...CHEQUER }}
              >
                <DesignedView
                  elements={filled(
                    template.elements,
                    SAMPLE.words,
                    SAMPLE.reference,
                  )}
                  theme={theme}
                />
              </span>
              <span className="mt-1.5 block truncate text-[12.5px] text-pulpitry-text">
                {template.name}
              </span>
              <span className="block truncate text-[11px] text-pulpitry-muted">
                {template.hint}
              </span>
            </button>
          ))}
        </div>

        {/*
          The six built into the renderer, which are not the same thing as the
          templates above and are kept because of the difference.

          A template is elements: a church copies one and owns it. These are
          geometry, and an output can be pointed straight at one without
          anything existing in this library at all -- which is what makes them
          the answer for a church that wants a lower third and nothing to do
          with a studio. They are drawn here by the renderer that draws them on
          the wall, so what is shown is what that output would send.

          Copying one gives a shape of your own at those proportions, for the
          church that likes where it sits and wants their logo in it.
        */}
        <p className="mt-5 mb-2 text-[11px] tracking-wide text-pulpitry-muted uppercase">
          Built in — usable as they are
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
          {OVERLAY_FORMS.filter(
            (form) => form.id !== "none" && form.id !== "stage",
          ).map((form) => (
            <button
              key={form.id}
              type="button"
              onClick={() =>
                setDesigning(
                  newItem(`${form.name} — ours`, {
                    kind: "overlay",
                    elements: shapeFromForm(form.id),
                  }),
                )
              }
              title={`${form.hint} Any output can use this as it is; copying gives you one of your own at these proportions.`}
              className="group flex flex-col gap-1 text-left focus-visible:focus-ring"
            >
              <span
                className="relative block w-full overflow-hidden rounded border border-pulpitry-line ring-pulpitry-teal group-hover:ring-2 [container-type:size]"
                style={{ aspectRatio: 16 / 9, ...CHEQUER }}
              >
                <OverlayView
                  form={form.id as OverlayForm}
                  theme={theme}
                  reference={SAMPLE.reference}
                  text={SAMPLE.words}
                  uppercase={false}
                  captions
                />
              </span>
              <span className="mt-1.5 block truncate text-[12.5px] text-pulpitry-text">
                {form.name}
              </span>
              <span className="block truncate text-[11px] text-pulpitry-muted">
                Copy to make it yours
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
