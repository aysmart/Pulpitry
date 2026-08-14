import { useState } from "react";

import { catalogSave, type Item } from "../lib/catalog";
import { describeError, generateSlides, type DraftSlide } from "../lib/api";

/**
 * Slides from a sermon, reviewed before anything is kept.
 *
 * An operator is handed an outline on Sunday morning — typed, or retyped from a
 * photograph of a notebook, or three headings and a verse. Turning that into
 * slides is twenty minutes nobody has, which is why so many services have none.
 *
 * # Nothing is saved until somebody has read it
 *
 * What comes back is a draft, shown here, and it reaches the library only when
 * the operator presses Keep. A model writing straight into a church's slide
 * library would put words nobody has read one gesture away from a wall in front
 * of a congregation.
 *
 * Each slide can be dropped on its own, because the usual outcome is not "all
 * of this" or "none of it" — it is six good slides and one that missed the
 * point.
 *
 * # Scripture is a reference, never text
 *
 * The model is told not to write verses out. Pulpitry holds eleven translations
 * and a model quoting from memory gets a verse subtly wrong in front of the
 * people most likely to notice. Where the outline cites a passage the reference
 * is shown, and the operator stages the real verse from the library beside it.
 */
export function SlidesFromSermon({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState("");
  const [drafts, setDrafts] = useState<DraftSlide[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState(0);

  const generate = async () => {
    setWorking(true);
    setError(null);
    setDrafts(null);
    try {
      setDrafts(await generateSlides(source));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(false);
    }
  };

  const keep = async (draft: DraftSlide, index: number) => {
    setError(null);
    try {
      const item: Item = {
        id: null,
        title: draft.title || "Untitled slide",
        subtitle: draft.reference,
        body: {
          kind: "slide",
          blocks: [
            // The title as a heading, the lines as body. The same shape the
            // slide editor produces by hand, so a kept slide is indistinguishable
            // from one somebody typed and can be edited the same way.
            ...(draft.title
              ? [
                  {
                    text: draft.title,
                    level: "heading" as const,
                    align: "center" as const,
                    bold: true,
                    italic: false,
                  },
                ]
              : []),
            ...draft.lines.map((text) => ({
              text,
              level: "body" as const,
              align: "center" as const,
              bold: false,
              italic: false,
            })),
          ],
        },
        path: null,
        updatedAt: Date.now(),
      };
      await catalogSave(item);
      setDrafts((current) => current?.filter((_, at) => at !== index) ?? null);
      setKept((n) => n + 1);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-full w-[620px] flex-col overflow-hidden rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl">
        <header className="shrink-0 border-b border-pulpitry-line px-5 py-3.5">
          <h2 className="text-[15px] text-pulpitry-text">Slides from a sermon</h2>
          <p className="mt-1 text-[11.5px] leading-snug text-pulpitry-muted">
            Paste the preacher&rsquo;s outline or notes. Nothing is saved until you keep it, and
            scripture stays a reference — Pulpitry shows the real verse from its own library.
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          <textarea
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Three points on Luke 15, or a page of notes…"
            spellCheck={false}
            className="h-40 w-full resize-y rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-2 text-[13px] leading-relaxed text-pulpitry-text outline-none focus-visible:focus-ring"
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={working || source.trim().split(/\s+/).length < 20}
              onClick={() => void generate()}
              className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-2 text-[13px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
            >
              {working ? "Making slides…" : "Make slides"}
            </button>
            {kept > 0 ? (
              <span className="text-[12px] text-pulpitry-muted">
                {kept} kept — they are in the slide library.
              </span>
            ) : null}
          </div>

          {error ? <p className="text-[12.5px] text-pulpitry-gold">{error}</p> : null}

          {drafts?.length === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-pulpitry-muted">
              Nothing here made slides. That is the honest answer to a page of notices — it was
              told to return nothing rather than invent something.
            </p>
          ) : null}

          {drafts?.map((draft, index) => (
            <div
              key={`${draft.title}-${index}`}
              className="flex flex-col gap-2 rounded border border-pulpitry-line px-3 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13.5px] text-pulpitry-text">
                  {draft.title || "Untitled"}
                </span>
                {draft.reference ? (
                  <span className="shrink-0 text-[11.5px] text-pulpitry-teal">
                    {draft.reference}
                  </span>
                ) : null}
              </div>

              {draft.lines.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-[12.5px] leading-snug text-pulpitry-muted">
                  {draft.lines.map((line, at) => (
                    <li key={at}>{line}</li>
                  ))}
                </ul>
              ) : null}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void keep(draft, index)}
                  className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1 text-[12px] text-pulpitry-text focus-visible:focus-ring"
                >
                  Keep
                </button>
                {/* Dropped one at a time, because the usual outcome is six good
                    slides and one that missed the point. */}
                <button
                  type="button"
                  onClick={() =>
                    setDrafts((current) => current?.filter((_, at) => at !== index) ?? null)
                  }
                  className="rounded px-2.5 py-1 text-[12px] text-pulpitry-muted underline-offset-2 hover:underline focus-visible:focus-ring"
                >
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>

        <footer className="flex shrink-0 justify-end border-t border-pulpitry-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[13px] text-pulpitry-text focus-visible:focus-ring"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
