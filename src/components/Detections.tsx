import { formatReference, type Verse } from "../lib/bible";
import type { Detection } from "../lib/useDetections";
import type { SpokenReference } from "../lib/useSpokenReferences";
import type { IndexStatus } from "../lib/useSemanticIndex";
import type { Suggestion } from "../lib/useSuggestions";
import { EmptyState } from "./Panel";

/**
 * Everything scripture-shaped the service has produced, in one list.
 *
 * These were two panels — quoted verses in one, paraphrase suggestions in
 * another — and splitting them split the operator's attention at the moment
 * they had least of it. A verse arrives, and the question is always the same:
 * *do I put this on the wall?* Answering it should not require looking in two
 * places and comparing timestamps to work out which came first.
 *
 * # The distinction survives the merge, and it must
 *
 * One list, three origins, and the difference between them is the whole point:
 *
 *   Announced   The speaker said where they were going. Nothing was inferred,
 *               so this is as certain as it gets and reads gold.
 *   Quoted      Matched word for word against the library. Confident, and
 *               reads teal.
 *   Paraphrase  A model thought this was being alluded to. It is a guess, it
 *               carries its confidence on its face, and it is drawn quieter
 *               than the other two on purpose.
 *
 * A guess must never wear a quotation's confidence. Merging the panels was
 * about where the operator looks, not about flattening what they are looking
 * at, so the marks below are deliberately the loudest thing in each row.
 */

type Row =
  | { kind: "announced"; verse: Verse; heard: string; at: number; key: string }
  | { kind: "quoted"; verse: Verse; heard: string; at: number; key: string }
  | {
      kind: "paraphrase";
      verse: Verse;
      heard: string;
      at: number;
      confidence: number;
      key: string;
    };

/** How each origin announces itself. The colour is the fastest signal. */
const MARK = {
  announced: { label: "Announced", tone: "text-pulpitry-gold border-pulpitry-gold-dim" },
  quoted: { label: "Quoted", tone: "text-pulpitry-teal border-pulpitry-teal/40" },
  paraphrase: { label: "Paraphrase", tone: "text-pulpitry-muted border-pulpitry-line" },
} as const;

export function Detections({
  detections,
  references,
  suggestions,
  onPreview,
  previewVerseId,
  liveVerseId,
  listening,
  index,
  assistEnabled,
}: {
  detections: Detection[];
  references: SpokenReference[];
  suggestions: Suggestion[];
  /**
   * Stages a verse. `andShow` puts it on screen in the same gesture — a
   * double-click, for when the operator already knows what they want there.
   */
  onPreview: (verse: Verse, andShow?: boolean) => void;
  previewVerseId: number | null;
  liveVerseId: number | null;
  listening: boolean;
  index: IndexStatus;
  assistEnabled: boolean;
}) {
  const rows: Row[] = [
    ...references.map((reference) => ({
      kind: "announced" as const,
      verse: reference.verse,
      heard: reference.phrase,
      at: reference.at,
      key: `ref-${reference.verse.id}-${reference.at}`,
    })),
    ...detections.map((detection) => ({
      kind: "quoted" as const,
      verse: detection.verse,
      heard: detection.snippet,
      at: detection.at,
      key: `det-${detection.verse.id}-${detection.at}`,
    })),
    ...suggestions.map((suggestion) => ({
      kind: "paraphrase" as const,
      verse: suggestion.verse,
      heard: suggestion.context,
      at: suggestion.at,
      confidence: suggestion.confidence,
      key: `sug-${suggestion.verse.id}-${suggestion.at}`,
    })),
  ];

  /*
   * Newest first, across all three.
   *
   * Sorting by arrival rather than grouping by origin is the point of merging
   * them: what a preacher said thirty seconds ago matters more than how we
   * came to know about it, and an operator scanning for "the thing just said"
   * should find it at the top whichever route it took.
   */
  rows.sort((a, b) => b.at - a.at);

  if (rows.length === 0) {
    /*
     * The empty state says which of several situations this is, because they
     * need different things from the operator. Paraphrase matching still
     * preparing is a wait; disabled is a setting; not listening is a button.
     */
    if (index.state === "building") {
      return (
        <EmptyState>
          Preparing {index.translation} for paraphrase matching —{" "}
          {index.total > 0 ? Math.floor((index.done / index.total) * 100) : 0}% done. Quoted
          scripture is already being detected; loose quotation joins once this finishes.
        </EmptyState>
      );
    }
    if (index.state === "error") {
      return <EmptyState>{index.error ?? "The paraphrase index could not be built."}</EmptyState>;
    }
    if (!listening) {
      return <EmptyState>Start listening and scripture will appear here as it is quoted.</EmptyState>;
    }
    return (
      <EmptyState>
        Listening.{" "}
        {index.state === "disabled" && !assistEnabled
          ? "Quoted scripture will be listed here; turn on paraphrase matching in Settings to have looser quotation suggested too."
          : "Quoted and paraphrased scripture will be listed here."}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-1">
      {rows.map((row) => {
        const isLive = row.verse.id === liveVerseId;
        const isPreview = row.verse.id === previewVerseId;
        const mark = MARK[row.kind];

        return (
          <button
            key={row.key}
            type="button"
            onClick={() => onPreview(row.verse)}
            onDoubleClick={() => onPreview(row.verse, true)}
            className={`flex w-full flex-col gap-1 rounded border px-2.5 py-2 text-left transition-colors focus-visible:focus-ring ${
              isLive
                ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                : isPreview
                  ? "border-pulpitry-teal/40 bg-pulpitry-raised"
                  : "border-pulpitry-line hover:bg-pulpitry-raised"
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={`text-[12px] ${
                  isLive
                    ? "text-pulpitry-gold"
                    : row.kind === "paraphrase"
                      ? "text-pulpitry-text"
                      : "text-pulpitry-teal"
                }`}
              >
                {formatReference(row.verse)}{" "}
                <span className="text-pulpitry-muted">{row.verse.translation}</span>
              </span>

              <span className="flex shrink-0 items-baseline gap-1.5">
                {/* A guess says so, and says how sure it is. The percentage sits
                    beside the word rather than replacing it: "Paraphrase 71%"
                    is a claim an operator can weigh; "71%" alone is not. */}
                {row.kind === "paraphrase" ? (
                  <span className="text-[11px] text-pulpitry-muted tabular-nums">
                    {Math.round(row.confidence * 100)}%
                  </span>
                ) : null}
                <span
                  className={`rounded-sm border px-1 text-[10px] uppercase tracking-wide ${mark.tone}`}
                >
                  {mark.label}
                </span>
              </span>
            </span>

            {/* What was actually said, so the operator judges the match rather
                than trusting it. */}
            {row.heard ? (
              <span className="line-clamp-2 text-[11.5px] leading-snug text-pulpitry-muted italic">
                “{row.heard}”
              </span>
            ) : null}

            <span className="line-clamp-2 text-[12.5px] leading-snug text-pulpitry-text">
              {row.verse.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
