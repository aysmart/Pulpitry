import {
  backgroundOf,
  fillsFrame,
  type LiveBody,
  type TextBlock,
} from "../lib/projector";
import { withBackground } from "../lib/design";
import { verticalStyle, type ProjectorTheme } from "../lib/theme";
import { Backdrop } from "./Backdrop";
import { LiveBodyView, type Extent } from "./LiveBodyView";

/**
 * What a slide will look like on the wall.
 *
 * The projector's own renderer inside a 16:9 box, on the operator's real
 * theme — the same typeface, colour, outline and background the congregation
 * will see. A stylised approximation would defeat the point of laying it out
 * at all.
 */
export function SlideCanvas({
  blocks,
  body,
  theme: churchTheme,
  progress = 0,
  onExtent,
}: {
  blocks: TextBlock[];
  /**
   * What to draw, where it is not simply blocks.
   *
   * A composed slide has components rather than lines, and drawing it from
   * `blocks` shows a table as a run of words -- which is what the operator's
   * panes did, so a slide that was correct on the wall looked broken on the
   * desk.
   */
  body?: LiveBody;
  theme: ProjectorTheme;
  /** How far through a long slide it is wound, 0 to 1. */
  progress?: number;
  /** How far it runs. This box is 16:9, and so is the projector's own text
   *  frame, so what it measures here is what the wall would. */
  onExtent?: (extent: Extent) => void;
}) {
  /*
   * A designed deck brings its own background, and it wins here.
   *
   * The church's look is still underneath everything else -- the reference's
   * typeface, the shadow, the texture -- but a deck built against a gradient
   * has to be drawn against that gradient on every surface, or the library card
   * and the wall show two different slides.
   */
  const theme = withBackground(churchTheme, backgroundOf(body));

  return (
    <div
      /*
       * `size`, not `inline-size`.
       *
       * `inline-size` establishes containment on the width only, so `cqh` inside
       * it is not resolvable and the browser falls back to the *viewport*
       * height. The padding below is `py-[5cqh]`, so in this box it was taking
       * 5% of the whole app window rather than 5% of the box -- a preview with
       * several times the vertical padding the wall has, and therefore a
       * different amount of room, a different wrap, and a different number of
       * lines than the thing it claims to be previewing.
       *
       * The 16:9 ratio below gives the box a definite height, which is what
       * `size` containment needs to resolve against.
       */
      className="relative w-full overflow-hidden rounded border border-pulpitry-line [container-type:size]"
      // Fixed, not taken from the display. Every surface that shows the
      // congregation's text is 16:9 -- this box, the Live pane, and the
      // projector's own frame -- so the same words break in the same places on
      // all of them.
      style={{ aspectRatio: 16 / 9 }}
    >
      <Backdrop theme={theme} playVideo={false} />

      {/* The same rule the projector uses, from the same function: a picture
          meant to be the screen is not inset, or the preview would disagree
          with the wall about where its edges are. */}
      <div
        className={`absolute inset-0 flex flex-col items-center ${
          body && fillsFrame(body) ? "" : "px-[6cqw] py-[5cqh]"
        }`}
        // The same placement the wall uses, from the same function.
        style={verticalStyle(theme)}
      >
        <LiveBodyView
          body={body ?? { kind: "richText", blocks }}
          theme={theme}
          unit="cqw"
          // The outline is authored in px against a ~1920px screen; at this
          // width the same value would swallow the letterforms.
          outlineScale={0.2}
          progress={progress}
          onExtent={onExtent}
        />
      </div>
    </div>
  );
}
