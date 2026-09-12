import { useCallback, useEffect, useState } from "react";

import { catalogRemove, newItem, type Item } from "../lib/catalog";
import { filled, listShapes, SAMPLE, starterShape } from "../lib/shapes";
import type { ProjectorTheme } from "../lib/theme";
import { DesignedView } from "./DesignedView";
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
        {shapes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="max-w-[40ch] text-[13px] leading-relaxed text-pulpitry-muted">
              Nothing drawn yet. Pulpitry ships six shapes — a lower third, a
              ribbon, a card and three others — and any output can use one of
              those without anything here.
            </p>
            <p className="max-w-[40ch] text-[11.5px] leading-relaxed text-pulpitry-muted">
              Draw your own when those are not your church&apos;s: your
              proportions, your colours, your logo in the corner.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
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
        )}
      </div>
    </div>
  );
}
