import { useState } from "react";

import { catalogSave, type Item } from "../lib/catalog";
import type { TextBlock } from "../lib/projector";
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
/**
 * A draft as the blocks a slide is made of.
 *
 * Three decisions about how it looks, and each was wrong in the first version.
 *
 * The title is a heading, which the renderer draws 1.4x larger — without that
 * every line came out the same size and the slide read as a paragraph that had
 * been chopped up.
 *
 * The reference goes *on* the slide, small and italic, rather than only into
 * the item's subtitle where the congregation never sees it. A citation that
 * exists in the library and not on the wall is a citation nobody can follow.
 *
 * And it is centred. A church slide is looked at, not read line by line, and
 * left-aligned fragments float against the left edge of a projector that is
 * rarely the same shape as the screen it is pointed at.
 */
export function blocksFor(draft: DraftSlide): TextBlock[] {
  const blocks: TextBlock[] = [];

  if (draft.title) {
    blocks.push({
      text: draft.title,
      level: "heading",
      align: "center",
      bold: true,
      italic: false,
    });
  }

  for (const text of draft.lines) {
    blocks.push({ text, level: "body", align: "center", bold: false, italic: false });
  }

  if (draft.reference) {
    // Italic and last: it is an attribution, and it should not compete with
    // the words it is attributing.
    blocks.push({
      text: draft.reference,
      level: "body",
      align: "center",
      bold: false,
      italic: true,
    });
  }

  return blocks;
}

export function SlidesFromSermon({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState("");
  const [drafts, setDrafts] = useState<DraftSlide[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState(0);
  // What the group is called. Offered rather than demanded: a sermon usually
  // has a title, and an operator who does not know it yet should not be stopped.
  const [title, setTitle] = useState("");

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

  /**
   * Keeps the whole sermon as one item.
   *
   * A group, like a song, and for the same reason: these slides were made
   * together and are used in order. Saving them one at a time scattered a
   * sermon across a library sorted by title, and made the operator reassemble
   * on Sunday what was assembled on Friday.
   *
   * Discarding is still per slide, before this — the point of reviewing is to
   * drop the one that missed, and what is kept is what is left.
   */
  const keep = async () => {
    if (!drafts || drafts.length === 0) return;
    setError(null);
    try {
      const item: Item = {
        id: null,
        title: title.trim() || "Sermon slides",
        subtitle: `${drafts.length} slide${drafts.length === 1 ? "" : "s"}`,
        body: {
          kind: "deck",
          sections: drafts.map((draft) => ({
            // The title labels the section, as a song's does, so the operator
            // can see what is coming in the section list.
            label: draft.title || "Slide",
            lines: [...draft.lines, ...(draft.reference ? [draft.reference] : [])],
          })),
        },
        path: null,
        updatedAt: Date.now(),
      };
      await catalogSave(item);
      setKept(drafts.length);
      setDrafts(null);
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
                Kept {kept} slide{kept === 1 ? "" : "s"} as one set, in the slide library.
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

              {/* Dropped one at a time, because the usual outcome is six good
                  slides and one that missed the point. Keeping is for the set. */}
              <button
                type="button"
                onClick={() =>
                  setDrafts((current) => current?.filter((_, at) => at !== index) ?? null)
                }
                className="self-start rounded px-2.5 py-1 text-[12px] text-pulpitry-muted underline-offset-2 hover:underline focus-visible:focus-ring"
              >
                Discard
              </button>
            </div>
          ))}
        </div>

        {drafts && drafts.length > 0 ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-pulpitry-line px-5 py-3">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What to call this set"
              className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring"
            />
            <button
              type="button"
              onClick={() => void keep()}
              className="shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[13px] text-pulpitry-text focus-visible:focus-ring"
            >
              Keep {drafts.length} as a set
            </button>
          </div>
        ) : null}

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
