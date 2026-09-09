import {
  backgroundStyle,
  backgroundUrl,
  pictureStyle,
  textureStyle,
  type ProjectorTheme,
} from "../lib/theme";

/**
 * Everything behind the words.
 *
 * One component for the projector, both stage panes, the slide editor and the
 * thumbnails, because they must agree: an operator who lays a slide out over a
 * gradient and gets a flat colour on the wall has been lied to. It renders in
 * layers — base, file, dim, texture — so a photograph can carry a scrim and a
 * grain at the same time.
 *
 * Absolutely positioned, so every caller wraps it in something `relative` and
 * puts the text after it.
 */
export function Backdrop({
  theme,
  /** Thumbnails show a still: a wall of playing video is costly and noisy. */
  playVideo = true,
}: {
  theme: ProjectorTheme;
  playVideo?: boolean;
}) {
  const file = backgroundUrl(theme);
  const texture = textureStyle(theme);

  return (
    <>
      {/* Under everything, and visible where a "contain" picture does not
          reach the edges: the bars are the theme's own colour rather than
          black, which is what makes contain usable at all. */}
      <div className="absolute inset-0" style={backgroundStyle(theme)} />

      {file && theme.backgroundKind === "image" ? (
        <img
          src={file}
          alt=""
          className="absolute inset-0 h-full w-full"
          style={pictureStyle(theme)}
        />
      ) : null}

      {file && theme.backgroundKind === "video" ? (
        <video
          src={file}
          autoPlay={playVideo}
          loop
          // A background is decoration; the hall has its own sound, and
          // browsers refuse to autoplay with audio anyway.
          muted
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full"
          style={pictureStyle(theme)}
        />
      ) : null}

      {/* Scrim. The most effective way to keep words readable over a bright
          photograph, and cheaper than fighting it with heavier outlines. */}
      {file && theme.backgroundDim > 0 ? (
        <div
          className="absolute inset-0"
          style={{ backgroundColor: `rgba(0,0,0,${theme.backgroundDim})` }}
        />
      ) : null}

      {texture ? (
        <div className="pointer-events-none absolute inset-0" style={texture} />
      ) : null}
    </>
  );
}
