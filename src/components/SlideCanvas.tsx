import type { TextBlock } from "../lib/projector";
import type { ProjectorTheme } from "../lib/theme";
import { Backdrop } from "./Backdrop";
import { LiveBodyView } from "./LiveBodyView";

/**
 * What a slide will look like on the wall.
 *
 * The projector's own renderer inside a 16:9 box, on the operator's real
 * theme — the same typeface, colour, outline and background the congregation
 * will see. A stylised approximation would defeat the point of laying it out
 * at all.
 */
export function SlideCanvas({ blocks, theme }: { blocks: TextBlock[]; theme: ProjectorTheme }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded border border-pulpitry-line [container-type:inline-size]">
      <Backdrop theme={theme} playVideo={false} />

      <div className="absolute inset-0 flex flex-col items-center justify-center px-[6cqw] py-[5cqh]">
        <LiveBodyView
          body={{ kind: "richText", blocks }}
          theme={theme}
          unit="cqw"
          // The outline is authored in px against a ~1920px screen; at this
          // width the same value would swallow the letterforms.
          outlineScale={0.2}
        />
      </div>
    </div>
  );
}

