import { formatReference, type Verse } from "../lib/bible";
import type { Detection } from "../lib/useDetections";
import type { SpokenReference } from "../lib/useSpokenReferences";
import { EmptyState } from "./Panel";

/**
 * Verses the speaker has quoted verbatim, newest first.
 *
 * Each row shows the operator both halves of the claim — what was heard and
 * what scripture says — so they can judge the match themselves rather than
 * trusting a percentage.
 */
export function DetectedVerses({
  detections,
  references,
  onPreview,
  previewVerseId,
  liveVerseId,
  listening,
}: {
  detections: Detection[];
  references: SpokenReference[];
  /**
   * Stages a verse. `andShow` puts it on screen in the same gesture — a
   * double-click, for when the operator already knows what they want there.
   */
  onPreview: (verse: Verse, andShow?: boolean) => void;
  previewVerseId: number | null;
  liveVerseId: number | null;
  listening: boolean;
}) {
  if (detections.length === 0 && references.length === 0) {
    return (
      <EmptyState>
        {listening
          ? "Listening for scripture quoted word for word."
          : "Start listening and quoted scripture will be listed here."}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* Announced references first: the speaker told us where they are going,
          so nothing here was inferred. */}
      {references.map((reference) => {
        const { verse } = reference;
        const isLive = verse.id === liveVerseId;
        const isPreview = verse.id === previewVerseId;

        return (
          <button
            key={`ref-${verse.id}-${reference.at}`}
            type="button"
            onClick={() => onPreview(verse)}
            onDoubleClick={() => onPreview(verse, true)}
            className={`flex w-full flex-col gap-1 rounded border px-2.5 py-2 text-left transition-colors focus-visible:focus-ring ${
              isLive
                ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                : isPreview
                  ? "border-pulpitry-teal bg-pulpitry-teal-dim"
                  : "border-pulpitry-gold-dim/50 bg-pulpitry-raised/40 hover:border-pulpitry-gold-dim"
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className={`text-[12px] ${isLive ? "text-pulpitry-gold" : "text-pulpitry-text"}`}>
                {formatReference(verse, reference.wholeChapter)}{" "}
                {/* Which translation this came from. Detection searches the
                    selected one, so an operator switching mid-service should
                    not have to work out which text they are looking at. */}
                <span className="text-pulpitry-muted">{verse.translation}</span>
              </span>
              <span className="shrink-0 rounded-sm border border-pulpitry-gold-dim px-1 text-[10px] tracking-wide text-pulpitry-gold uppercase">
                announced
              </span>
            </span>
            <span className="text-[11.5px] leading-snug text-pulpitry-muted italic">
              “{reference.phrase}”
            </span>
            <span className="line-clamp-2 text-[12.5px] leading-snug text-pulpitry-text">
              {verse.text}
            </span>
          </button>
        );
      })}

      {detections.map((detection) => {
        const { verse } = detection;
        const isLive = verse.id === liveVerseId;
        const isPreview = verse.id === previewVerseId;

        return (
          <button
            key={`${verse.id}-${detection.at}`}
            type="button"
            onClick={() => onPreview(verse)}
            onDoubleClick={() => onPreview(verse, true)}
            className={`flex w-full flex-col gap-1 rounded border px-2.5 py-2 text-left transition-colors focus-visible:focus-ring ${
              isLive
                ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                : isPreview
                  ? "border-pulpitry-teal bg-pulpitry-teal-dim"
                  : "border-pulpitry-line bg-pulpitry-raised/40 hover:border-pulpitry-teal"
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={`text-[12px] ${isLive ? "text-pulpitry-gold" : "text-pulpitry-teal"}`}
              >
                {formatReference(verse)}{" "}
                <span className="text-pulpitry-muted">{verse.translation}</span>
              </span>
              <span className="shrink-0 text-[11px] text-pulpitry-muted tabular-nums">
                {Math.round(detection.confidence * 100)}%
              </span>
            </span>

            {/* What the speaker said. */}
            <span className="text-[11.5px] leading-snug text-pulpitry-muted italic">
              “{detection.snippet}”
            </span>

            {/* What scripture says. */}
            <span className="line-clamp-3 text-[12.5px] leading-snug text-pulpitry-text">
              {verse.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
