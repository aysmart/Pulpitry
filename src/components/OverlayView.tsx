import { chipStyle, overlayPlan, type OverlayForm } from "../lib/overlays";
import type { ProjectorTheme } from "../lib/theme";

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
}: {
  form: OverlayForm;
  theme: ProjectorTheme;
  reference: string | null;
  text: string | null;
  /** Whether this output sets its words in capitals. */
  uppercase: boolean;
}) {
  if (!text || !text.trim()) return null;

  const plan = overlayPlan(form, theme, uppercase);
  const showReference = theme.showReference && Boolean(reference);

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
        <span style={plan.body}>{text}</span>
        {!plan.chip && !plan.inline && showReference ? (
          <span style={{ ...plan.reference, display: "block", opacity: 0.85 }}>
            {reference}
          </span>
        ) : null}
      </div>
    </div>
  );
}
