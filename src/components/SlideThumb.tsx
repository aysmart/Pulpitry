import { fontStack, type ProjectorTheme } from "../lib/theme";
import { Backdrop } from "./Backdrop";
import {
  currentSection,
  presentableLabel,
  presentableText,
  type Presentable,
} from "../lib/usePresentation";

/**
 * A rendered preview of one slide, at thumbnail size.
 *
 * The point is picking by sight rather than reading a list: the operator sees
 * the actual background, typeface and colour the congregation will see, so the
 * right slide is recognisable at a glance mid-service.
 *
 * It renders the real theme rather than a stylised stand-in, which is why the
 * background and typeface are wired through — a mock would defeat the purpose.
 */
export function SlideThumb({
  item,
  theme,
  state,
  onSelect,
  label,
}: {
  item: Presentable;
  theme: ProjectorTheme;
  state: "idle" | "preview" | "live";
  onSelect: () => void;
  /** Overrides the item's own label, e.g. a section name. */
  label?: string;
}) {
  const text = presentableText(item);
  // A lyric breaks where the writer broke it, and the slide will show it that
  // way. A thumbnail that reflows into a paragraph is not a preview.
  const lines = currentSection(item)?.lines ?? null;

  // Thumbnails are ~180px wide against a ~1920px screen, so type has to be
  // scaled by roughly that ratio or a slide would show two words.
  const size = text.length < 90 ? 8.5 : text.length < 220 ? 6.5 : 5;

  return (
    <button
      type="button"
      onClick={onSelect}
      title={label ?? presentableLabel(item)}
      className={`group flex flex-col gap-1 rounded text-left focus-visible:focus-ring ${
        state === "live" ? "ring-2 ring-pulpitry-gold" : state === "preview" ? "ring-2 ring-pulpitry-teal" : ""
      }`}
    >
      <span
        className="relative block aspect-video w-full overflow-hidden rounded-sm border border-pulpitry-line [container-type:inline-size]"
      >
        <Backdrop theme={theme} playVideo={false} />

        <span
          className="absolute inset-0 flex items-center justify-center px-[6%] text-center leading-[1.25]"
          style={{
            fontFamily: fontStack(theme.fontFamily),
            color: theme.textColor,
            // cqw so type scales with the thumbnail rather than the viewport;
            // the wrapper below establishes the container.
            fontSize: `${size}cqw`,
          }}
        >
          <span className="line-clamp-6">
            {lines
              ? lines.map((line, index) => (
                  <span key={index} className="block">
                    {line}
                  </span>
                ))
              : text}
          </span>
        </span>
      </span>

      <span className="truncate text-[11px] text-pulpitry-muted group-hover:text-pulpitry-text">
        {label ?? presentableLabel(item)}
      </span>
    </button>
  );
}
