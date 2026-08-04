import { convertFileSrc } from "@tauri-apps/api/core";

import { bodyText, type LiveBody, type LiveContent } from "../lib/projector";
import { backgroundUrl, fontStack, type ProjectorTheme } from "../lib/theme";
import { presentableLabel, presentableText, type Presentable } from "../lib/usePresentation";
import { EmptyState, Panel } from "./Panel";

function Stage({
  body,
  asset,
  reference,
  tone,
  empty,
  theme,
}: {
  body: string | null;
  /** A picture or clip, which fills the pane instead of the text layout. */
  asset?: { kind: "image" | "media"; path: string; looping: boolean } | null;
  reference: string | null;
  tone: "preview" | "live";
  empty: string;
  /** Set on the Live pane, so it previews what the congregation actually sees. */
  theme?: ProjectorTheme;
}) {
  if (asset) {
    return (
      <div className="flex h-full items-center justify-center bg-pulpitry-ink" data-selectable>
        {asset.kind === "image" ? (
          <img src={convertFileSrc(asset.path)} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <video
            src={convertFileSrc(asset.path)}
            // Muted here on purpose: the operator's pane should not double the
            // sound the congregation is already hearing from the projector.
            muted
            autoPlay={tone === "live"}
            loop={asset.looping}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
    );
  }

  if (!body) {
    return <EmptyState>{empty}</EmptyState>;
  }

  const media = theme ? backgroundUrl(theme) : null;

  // Outline width is authored for a projector; at panel scale the same value
  // would swallow the letterforms.
  const outline = theme && theme.outlineWidth > 0 ? theme.outlineWidth / 4 : 0;

  return (
    <div
      className="relative h-full overflow-hidden"
      style={theme ? { backgroundColor: theme.backgroundColor } : undefined}
      data-selectable
    >
      {media && theme?.backgroundKind === "image" ? (
        <img src={media} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      {media && theme?.backgroundKind === "video" ? (
        <video src={media} autoPlay loop muted playsInline className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      {media && theme && theme.backgroundDim > 0 ? (
        <div
          className="absolute inset-0"
          style={{ backgroundColor: `rgba(0,0,0,${theme.backgroundDim})` }}
        />
      ) : null}

      <div className="relative flex h-full flex-col justify-center gap-3 px-6 py-5">
        <p
          className={`text-center text-[clamp(1rem,2.1vw,1.6rem)] leading-[1.35] text-balance ${
            theme ? "" : "scripture-type"
          } ${tone === "live" && !theme ? "text-pulpitry-text" : theme ? "" : "text-pulpitry-text/80"}`}
          style={
            theme
              ? {
                  fontFamily: fontStack(theme.fontFamily),
                  color: theme.textColor,
                  ...(outline
                    ? {
                        WebkitTextStrokeWidth: `${outline}px`,
                        WebkitTextStrokeColor: theme.outlineColor,
                        paintOrder: "stroke fill",
                      }
                    : {}),
                  ...(theme.shadow ? { textShadow: "0 0.06em 0.14em rgba(0,0,0,0.55)" } : {}),
                }
              : undefined
          }
        >
          {body}
        </p>
        {reference && (!theme || theme.showReference) ? (
          <p
            className={`text-center text-[12px] tracking-wide ${
              theme ? "opacity-60" : tone === "live" ? "text-pulpitry-gold" : "text-pulpitry-muted"
            }`}
            style={theme ? { color: theme.textColor } : undefined}
          >
            {reference}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The picture or clip behind an item, if that is what it is. */
function assetOf(item: Presentable | null) {
  if (item?.kind === "image") return { kind: "image" as const, path: item.path, looping: false };
  if (item?.kind === "media")
    return { kind: "media" as const, path: item.path, looping: item.looping };
  return null;
}

/** The same, for whatever the projector is currently showing. */
function liveAsset(body: LiveBody | undefined) {
  if (body?.kind === "image") return { kind: "image" as const, path: body.path, looping: false };
  if (body?.kind === "media")
    return { kind: "media" as const, path: body.path, looping: body.looping };
  return null;
}

const CONTROL =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-2 text-[13px] text-pulpitry-text transition-opacity hover:border-pulpitry-muted disabled:opacity-35 focus-visible:focus-ring";

/**
 * Preview and Live, with the transport between them.
 *
 * Live is read from the shared state rather than this window's own, so what is
 * shown here is by construction what the projector is showing.
 */
export function StagePanel({
  preview,
  live,
  onDisplay,
  onClear,
  onStep,
  onAdd,
  theme,
  canStepBack,
  canStepForward,
}: {
  preview: Presentable | null;
  live: LiveContent | null;
  onDisplay: () => void;
  onClear: () => void;
  onStep: (forward: boolean) => void;
  onAdd: () => void;
  theme: ProjectorTheme;
  canStepBack: boolean;
  canStepForward: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Panel title="Preview" className="flex-1">
        <Stage
          body={preview ? presentableText(preview) : null}
          asset={assetOf(preview)}
          reference={preview ? presentableLabel(preview) : null}
          tone="preview"
          empty="Pick a verse from the Chapter panel to stage it."
        />
      </Panel>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onDisplay}
          disabled={!preview}
          className="flex-1 rounded bg-pulpitry-gold px-4 py-2 text-[13px] text-pulpitry-ink transition-opacity hover:bg-pulpitry-gold/90 disabled:opacity-35 focus-visible:focus-ring"
        >
          Display
        </button>
        <button type="button" onClick={() => onStep(false)} disabled={!canStepBack} className={CONTROL}>
          Prev
        </button>
        <button type="button" onClick={() => onStep(true)} disabled={!canStepForward} className={CONTROL}>
          Next
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={!preview}
          title="Add what is staged to the service plan"
          className={CONTROL}
        >
          Add
        </button>
        <button type="button" onClick={onClear} disabled={!live} className={CONTROL}>
          Clear
        </button>
      </div>

      <Panel title="Live" accent="gold" className="flex-1">
        <Stage
          body={live ? bodyText(live.body) : null}
          asset={liveAsset(live?.body)}
          reference={live?.caption ?? null}
          tone="live"
          empty="Nothing is on the projector."
          theme={theme}
        />
      </Panel>
    </div>
  );
}
