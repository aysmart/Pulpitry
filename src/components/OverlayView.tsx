import { chipStyle, overlayPlan, type OverlayForm } from "../lib/overlays";
import { runsText, type VerseRun } from "../lib/projector";
import type { ProjectorTheme } from "../lib/theme";
import { VerseRuns } from "./VerseRuns";

/**
 * A scripture overlay, drawn on nothing.
 *
 * Everything here sits over transparency so a switcher at the far end can key
 * it across a camera. There is deliberately no background, no dim and no
 * texture: the moment this draws anything full-frame it stops being an overlay
 * and becomes a picture of one.
 *
 * Nothing at all when there is nothing live. A band holding no verse is the
 * bug their competitor shipped and fixed; an overlay with nothing in it should
 * simply not be on the screen.
 */
export function OverlayView({
  form,
  theme,
  reference,
  text,
  uppercase,
  captions,
}: {
  form: OverlayForm;
  theme: ProjectorTheme;
  reference: string | null;
  /** The words in runs, so a passage's verse numbers are raised in the band
   *  exactly as they are on the wall behind it. */
  text: VerseRun[] | null;
  /** Whether this output sets its words in capitals. */
  uppercase: boolean;
  /**
   * Whether a title or reference is shown at all, where the desk has an
   * opinion that differs from this output's own look.
   *
   * An output may name a template of its own -- a church's brand colours for
   * the stream, say -- and then it stops following the wall's look entirely.
   * That is right for *how* it is drawn and wrong for *whether a caption
   * exists*, which is a decision about the words: the song desk says its
   * titles are not shown and the lower third went on showing them.
   *
   * Absent falls back to this output's own theme, which is what a preview and
   * anything without a desk behind it should use.
   */
  captions?: boolean;
}) {
  if (!text || !runsText(text).trim()) return null;

  const plan = overlayPlan(form, theme, uppercase);
  const showReference =
    (captions ?? theme.showReference) && Boolean(reference);

  return (
    <div
      style={{
        position: "absolute",
        display: "flex",
        flexDirection: "column",
        ...plan.frame,
      }}
    >
      {/* Above the band, on its own paper chip — the arrangement a broadcast
          lower third has used for decades, because it separates the citation
          from the quotation without a second colour. */}
      {plan.chip && showReference ? (
        <span style={{ ...plan.reference, ...chipStyle(theme) }}>
          {reference}
        </span>
      ) : null}

      <div style={plan.band}>
        {plan.inline && showReference ? (
          <span style={plan.reference}>{reference}</span>
        ) : null}
        {/* One line per line, because the breaks are meaning: the song desk
            decides how many lines a screenful is, and a lower third showing
            the same screenful as one wrapped run is showing a different
            shape from the one the room is reading. */}
        {/*
          A block, and that is the whole of why these were ranged left.

          Every form sets `textAlign` on the body, and this was a `span` --
          inline, so the box hugs its words and the alignment applies to
          nothing. The band is the block, and it never had an alignment of its
          own, so a centred lower third was centred in name only.

          `pre-line` because the breaks are meaning: the song desk decides how
          many lines a screenful is, and the lower third shows the same one.
        */}
        <span
          style={{ ...plan.body, display: "block", whiteSpace: "pre-line" }}
        >
          <VerseRuns runs={text} />
        </span>
        {!plan.chip && !plan.inline && showReference ? (
          <span style={{ ...plan.reference, display: "block", opacity: 0.85 }}>
            {reference}
          </span>
        ) : null}
      </div>
    </div>
  );
}
