import { convertFileSrc } from "@tauri-apps/api/core";

import type { LiveBody } from "../lib/projector";
import { fontStack, textStyle, type ProjectorTheme } from "../lib/theme";

/**
 * Renders whatever is live, in whatever shape it takes.
 *
 * Shared by the projector and the operator's Live pane so the two cannot drift
 * apart: `scale` shrinks projector-sized values for the small pane rather than
 * duplicating the layout.
 */
export function LiveBodyView({
  body,
  theme,
  scale = 1,
}: {
  body: LiveBody;
  theme: ProjectorTheme;
  scale?: number;
}) {
  const text = body.kind === "scripture" ? body.lines.map((l) => l.text).join(" ") : "";
  const base = textStyle(theme, text);

  // Outline is authored for a projector; at panel scale the same value would
  // swallow the letterforms.
  const style =
    scale === 1
      ? base
      : {
          ...base,
          fontSize: undefined,
          WebkitTextStrokeWidth: theme.outlineWidth
            ? `${theme.outlineWidth * scale}px`
            : undefined,
        };

  switch (body.kind) {
    case "scripture":
      return (
        <p className="w-full text-center leading-[1.3] text-balance" style={style}>
          {body.lines.map((line, index) => (
            <span key={line.number}>
              {/* Verse numbers only earn their place when several are shown
                  together; a single verse already has its reference beneath. */}
              {body.lines.length > 1 ? (
                <sup className="mr-[0.25em] align-super text-[0.5em] opacity-55">{line.number}</sup>
              ) : null}
              {line.text}
              {index < body.lines.length - 1 ? " " : null}
            </span>
          ))}
        </p>
      );

    case "lyric":
      return (
        <p className="w-full text-center leading-[1.35]" style={style}>
          {body.lines.map((line, index) => (
            <span key={index} className="block">
              {line}
            </span>
          ))}
        </p>
      );

    case "richText":
      return (
        <div className="flex w-full flex-col gap-[0.4em]">
          {body.blocks.map((block, index) => (
            <p
              key={index}
              style={{
                ...style,
                fontFamily: fontStack(theme.fontFamily),
                fontWeight: block.bold ? 600 : 400,
                fontStyle: block.italic ? "italic" : "normal",
                textAlign: block.align,
                fontSize:
                  block.level === "heading" && typeof style.fontSize === "string"
                    ? `calc(${style.fontSize} * 1.4)`
                    : style.fontSize,
              }}
            >
              {block.text}
            </p>
          ))}
        </div>
      );

    case "image":
      return (
        <img
          src={convertFileSrc(body.path)}
          alt=""
          className="max-h-full max-w-full object-contain"
        />
      );

    case "media":
      return (
        <video
          src={convertFileSrc(body.path)}
          autoPlay
          loop={body.looping}
          // Audible, unlike a background: a clip played as content is meant to
          // be heard.
          controls={false}
          className="max-h-full max-w-full object-contain"
        />
      );
  }
}
