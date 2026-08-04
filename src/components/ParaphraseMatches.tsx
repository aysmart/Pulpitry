import { formatReference, type Verse } from "../lib/bible";
import type { IndexStatus } from "../lib/useSemanticIndex";
import type { Suggestion } from "../lib/useSuggestions";
import { EmptyState } from "./Panel";

function percent(index: IndexStatus): number {
  if (index.total <= 0) return 0;
  return Math.floor((index.done / index.total) * 100);
}

/**
 * Passages the speaker appears to be referring to in their own words.
 *
 * Two independent things fill this list. The local embedding index matches by
 * meaning, offline and free. The optional model catches looser allusion but
 * costs a request. Each row says which produced it, because they deserve
 * different amounts of trust.
 *
 * Either way the verse text is read from the local library, so a passage that
 * does not exist cannot appear here at all.
 */
export function ParaphraseMatches({
  suggestions,
  onPreview,
  previewVerseId,
  liveVerseId,
  index,
  assistEnabled,
  listening,
}: {
  suggestions: Suggestion[];
  onPreview: (verse: Verse) => void;
  previewVerseId: number | null;
  liveVerseId: number | null;
  index: IndexStatus;
  assistEnabled: boolean;
  listening: boolean;
}) {
  const building = index.state === "building";

  if (suggestions.length === 0) {
    if (index.state === "disabled" && !assistEnabled) {
      return (
        <EmptyState>
          Turn on paraphrase matching in Settings to have loosely quoted scripture suggested
          here.
        </EmptyState>
      );
    }
    if (index.state === "error") {
      return <EmptyState>{index.error ?? "The paraphrase index could not be built."}</EmptyState>;
    }
    if (building) {
      return (
        <EmptyState>
          Preparing {index.translation} for paraphrase matching — {percent(index)}% done. This
          happens once.
        </EmptyState>
      );
    }
    return (
      <EmptyState>
        {listening
          ? "Watching for scripture referred to in the speaker’s own words."
          : "Start listening to have paraphrased references suggested here."}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-1">
      {building ? (
        <p className="px-1.5 py-1 text-[11px] text-pulpitry-muted">
          Still preparing {index.translation} — {percent(index)}%
        </p>
      ) : null}

      {suggestions.map((suggestion) => {
        const { verse } = suggestion;
        const isLive = verse.id === liveVerseId;
        const isPreview = verse.id === previewVerseId;
        const local = suggestion.source === "semantic";

        return (
          <button
            key={`${verse.id}-${suggestion.at}`}
            type="button"
            onClick={() => onPreview(verse)}
            className={`flex w-full flex-col gap-1 rounded border px-2.5 py-2 text-left transition-colors focus-visible:focus-ring ${
              isLive
                ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                : isPreview
                  ? "border-pulpitry-teal bg-pulpitry-teal-dim"
                  : "border-pulpitry-line bg-pulpitry-raised/40 hover:border-pulpitry-teal"
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className={`text-[12px] ${isLive ? "text-pulpitry-gold" : "text-pulpitry-teal"}`}>
                {formatReference(verse)}{" "}
                <span className="text-pulpitry-muted">{verse.translation}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span
                  title={
                    local
                      ? "Matched locally by meaning — no network involved"
                      : "Proposed by the model; the reference was verified against your library"
                  }
                  className="rounded-sm border border-pulpitry-line px-1 text-[10px] tracking-wide text-pulpitry-muted uppercase"
                >
                  {local ? "local" : "model"}
                </span>
                <span className="text-[11px] text-pulpitry-muted tabular-nums">
                  {Math.round(suggestion.confidence * 100)}%
                </span>
              </span>
            </span>

            {suggestion.reason ? (
              <span className="text-[11.5px] leading-snug text-pulpitry-muted italic">
                {suggestion.reason}
              </span>
            ) : null}

            <span className="line-clamp-3 text-[12.5px] leading-snug text-pulpitry-text">
              {verse.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
