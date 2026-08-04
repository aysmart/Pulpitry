import type { TextBlock } from "../lib/projector";
import { backgroundUrl, type ProjectorTheme } from "../lib/theme";
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
  const media = backgroundUrl(theme);
  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded border border-pulpitry-line [container-type:inline-size]"
      style={{ backgroundColor: theme.backgroundColor }}
    >
      {media && theme.backgroundKind === "image" ? (
        <img src={media} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      {media && theme.backgroundKind === "video" ? (
        <video
          src={media}
          muted
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
      {media && theme.backgroundDim > 0 ? (
        <div
          className="absolute inset-0"
          style={{ backgroundColor: `rgba(0,0,0,${theme.backgroundDim})` }}
        />
      ) : null}

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

