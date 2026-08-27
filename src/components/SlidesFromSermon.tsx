import { useState } from "react";

import { catalogSave, type Item } from "../lib/catalog";
import { SlidePicture } from "./SlidePicture";
import {
  layoutFor,
  type ImageSource,
  type SlideComponent,
  type TextBlock,
} from "../lib/projector";
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
/**
 * The same slide, as components.
 *
 * Stored alongside the blocks rather than instead of them: `blocks` is what
 * every slide made before this existed carries and what an older build knows
 * how to draw, and there is no reason a slide kept today should stop working
 * if this is rolled back.
 *
 * A pure mapping for now, from the three fields a draft has. It exists so the
 * component renderer is exercised by real slides made from real services
 * before the model is taught to produce tables and figures -- if the shape is
 * wrong, it is much cheaper to find out here.
 */
/**
 * A point as one string.
 *
 * For everything that wants the words and not the shape: the flat `lines` a
 * deck stores for a build that predates headings, and the blocks a slide keeps
 * for one that predates components.
 */
export function flatPoint(point: { heading: string; text: string }): string {
  return point.heading ? `${point.heading}: ${point.text}` : point.text;
}

export function componentsFor(draft: DraftSlide, picture?: ImageSource | null): SlideComponent[] {
  const components: SlideComponent[] = [];

  if (draft.title) {
    components.push({ kind: "text", text: draft.title, level: "title" });
  }

  /*
   * Before the words, because the arrangement puts it behind them.
   *
   * Not anchored, and it is the only thing on a slide that is not: everything
   * else asserts that something was said, and a photograph of an open sky
   * asserts nothing. There is no sentence in the transcript it could be
   * checked against, because it does not claim anything to check.
   */
  if (picture) {
    components.push({ kind: "figure", source: picture });
  }

  /*
   * One line is a statement; several are a list.
   *
   * The distinction is the whole reason components exist. Three parallel points
   * ranged left read as three points; the same three centred and stacked read
   * as a paragraph that has been broken up, which is what every slide looked
   * like before this.
   */
  /*
   * A comparison takes the body of the slide, and the lines stand down.
   *
   * The two are alternatives rather than companions: a preacher who set two
   * things side by side made that the point, and three centred lines beneath a
   * table are the same words twice.
   */
  /*
   * Figures take the body, as a comparison does.
   *
   * A chart with three bullets beside it is a slide asking to be read twice.
   * The preacher gave numbers; the numbers are the point.
   */
  if (draft.chart) {
    components.push({
      kind: "chart",
      label: draft.chart.label,
      bars: draft.chart.bars,
    });
    if (draft.reference) {
      components.push({ kind: "passage", reference: draft.reference });
    }
    return components;
  }

  if (draft.table) {
    components.push({
      kind: "table",
      header: draft.table.header,
      rows: draft.table.rows,
    });
    if (draft.reference) {
      components.push({ kind: "passage", reference: draft.reference });
    }
    return components;
  }

  /*
   * A movement beginning carries its heading and nothing else.
   *
   * `layoutFor` then calls it a section on its own, because a slide with no
   * body *is* a section marker -- so nothing here has to know about layouts.
   * The reference is dropped with the rest: a heading that opens a stretch of
   * sermon is not a citation.
   */
  if (draft.opens) return components;

  const [only] = draft.lines;
  if (draft.lines.length === 1 && only) {
    // One point is a statement, not a list of one -- and not a card either: a
    // single panel is a box drawn round a sentence for no reason.
    components.push({ kind: "text", text: flatPoint(only), level: "statement" });
  } else if (draft.lines.length > 1) {
    components.push({
      kind: "list",
      // A point with no heading crosses as a plain string rather than as an
      // object with an empty one, so "has a heading" stays a question about
      // the shape of the data and not about whether a field is blank.
      items: draft.lines.map((point) =>
        point.heading ? { heading: point.heading, text: point.text } : point.text,
      ),
      ordered: false,
    });
  }

  if (draft.reference) {
    components.push({ kind: "passage", reference: draft.reference });
  }

  return components;
}

/**
 * A draft as the deck section it is stored as.
 *
 * The whole section, not just its components. This was written out at both
 * save sites and the copies drifted: the one an operator actually uses had its
 * own idea of what a slide was made of and dropped every table the model
 * produced. Then the layout was hardcoded in both, so no slide ever had an
 * arrangement other than a centred stack.
 *
 * One function, so there is one answer to what a slide is.
 */
export function sectionFor(draft: DraftSlide, picture?: ImageSource | null) {
  const components = componentsFor(draft, picture);
  return {
    // The title labels the section, as a song's does, so the operator can see
    // what is coming in the section list.
    label: draft.title || "Slide",
    // Kept as well as the components: a deck saved today still opens in a
    // build that predates them, and lines are what that build draws.
    lines: [...draft.lines.map(flatPoint), ...(draft.reference ? [draft.reference] : [])],
    components,
    // Derived rather than chosen. Nobody is asked and the model is not either:
    // an arrangement is a function of what the slide is made of.
    layout: layoutFor(components),
  };
}

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

  for (const point of draft.lines) {
    blocks.push({
      text: flatPoint(point),
      level: "body",
      align: "center",
      bold: false,
      italic: false,
    });
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
          sections: drafts.map((draft) => sectionFor(draft, draft.picture)),
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

              {draft.table ? (
                <table className="w-full border-collapse text-left text-[11.5px] text-pulpitry-muted">
                  <thead>
                    <tr>
                      {draft.table.header.map((cell, at) => (
                        <th
                          key={at}
                          scope="col"
                          className="border-b border-pulpitry-line pr-3 pb-1 font-semibold text-pulpitry-text"
                        >
                          {cell}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {draft.table.rows.map((row, at) => (
                      <tr key={at}>
                        {row.map((cell, index) => (
                          <td key={index} className="pr-3 pt-1 align-top">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}

              {draft.lines.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-[12.5px] leading-snug text-pulpitry-muted">
                    {draft.lines.map((point, at) => (
                    <li key={at}>
                      {point.heading ? (
                        <strong className="font-semibold text-pulpitry-text">
                          {point.heading}:{" "}
                        </strong>
                      ) : null}
                      {point.text}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* What the preacher actually said, beneath the slide it became.
                  Every slide here has already been checked against the
                  transcript; this is so the operator can see *what* it was
                  checked against without opening the transcript beside it. */}
              {draft.anchor ? (
                <p className="border-l-2 border-pulpitry-teal-dim pl-2 text-[10px] leading-[1.45] text-pulpitry-muted/80 italic">
                  “{draft.anchor.length > 180
                    ? `${draft.anchor.slice(0, 180).trimEnd()}…`
                    : draft.anchor}”
                </p>
              ) : null}

              <SlidePicture
                source={draft.picture ?? null}
                onChange={(picture) =>
                  setDrafts(
                    (current) =>
                      current?.map((slide, at) =>
                        at === index ? { ...slide, picture } : slide,
                      ) ?? null,
                  )
                }
              />

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
