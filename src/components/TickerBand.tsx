import type { Ticker } from "../lib/projector";
import { fontStack, withAlpha, type ProjectorTheme } from "../lib/theme";

/**
 * A notice crawling across the screen, over whatever is live.
 *
 * Shared by the projector and the operator's Live pane, so the operator can
 * see what the congregation is reading rather than trusting that it is there.
 *
 * The band is sized in cqw/cqh so it holds the same proportion whether it is
 * drawn on a wall or in a panel; every caller establishes the container.
 */
export function TickerBand({
  ticker,
  theme,
}: {
  ticker: Ticker;
  theme: ProjectorTheme;
}) {
  if (!ticker.visible || !ticker.text.trim()) return null;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-10 overflow-hidden ${
        ticker.position === "top" ? "top-0" : "bottom-0"
      }`}
      style={{
        backgroundColor: withAlpha(ticker.bandColor, ticker.bandOpacity),
        paddingBlock: "1.1cqh",
      }}
    >
      <div
        className="whitespace-nowrap will-change-transform"
        style={{
          fontFamily: fontStack(theme.fontFamily),
          color: ticker.textColor,
          fontSize: "2.4cqw",
          animation: `pulpitry-ticker ${ticker.speed}s linear infinite`,
        }}
      >
        {ticker.text}
      </div>
    </div>
  );
}
