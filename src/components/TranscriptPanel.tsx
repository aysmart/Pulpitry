import { useEffect, useRef } from "react";

import type { SpeechStatus } from "../lib/api";
import type { TranscriptLine } from "../lib/useTranscript";
import { EmptyState, Panel } from "./Panel";

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function TranscriptPanel({
  lines,
  interim,
  status,
  onClear,
  onExport,
  onOpenHistory,
  exporting,
}: {
  lines: TranscriptLine[];
  interim: string;
  status: SpeechStatus;
  onClear: () => void;
  onExport: () => void;
  onOpenHistory: () => void;
  exporting: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Follow the speaker, but stop fighting the operator if they scroll back to
  // re-read something.
  useEffect(() => {
    if (pinnedToBottom.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [lines, interim]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinnedToBottom.current = distance < 48;
  };

  const empty = lines.length === 0 && !interim;

  return (
    <Panel
      tour="transcript"
      title="Live Transcription"
      accent={status.state === "listening" ? "gold" : "neutral"}
      actions={
        <div className="flex gap-0.5">
          {/* Always offered, unlike Export and Clear: the moment somebody
              wants last week's transcript is exactly when this one is
              empty. */}
          <button
            type="button"
            onClick={onOpenHistory}
            title="Look back at what was preached: transcripts, summaries and exports"
            className="rounded px-1.5 py-0.5 text-[11px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
          >
            Past services
          </button>
          {lines.length > 0 ? (
            <>
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              title="Save the transcript as a text file"
              className="rounded px-1.5 py-0.5 text-[11px] text-pulpitry-muted transition-colors hover:text-pulpitry-text disabled:opacity-50 focus-visible:focus-ring"
            >
              {exporting ? "Saving…" : "Export"}
            </button>
            <button
              type="button"
              onClick={onClear}
              className="rounded px-1.5 py-0.5 text-[11px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
            >
              Clear
            </button>
            </>
          ) : null}
        </div>
      }
      bodyClassName="px-3 py-2"
    >
      {empty ? (
        <EmptyState>
          {status.state === "listening"
            ? "Listening — spoken words will appear here as they are recognised."
            : "Start listening to transcribe the message live."}
        </EmptyState>
      ) : (
        <div ref={scrollRef} onScroll={handleScroll} className="h-full">
          <div className="flex flex-col gap-2" data-selectable>
            {lines.map((line) => (
              <p key={line.id} className="text-[13.5px] leading-relaxed text-pulpitry-text">
                <span className="mr-2 select-none text-[11px] text-pulpitry-muted tabular-nums">
                  {time.format(line.at)}
                </span>
                {line.text}
              </p>
            ))}

            {/* Interim text is still being revised by the recogniser. */}
            {interim ? (
              <p className="text-[13.5px] leading-relaxed text-pulpitry-muted italic">{interim}</p>
            ) : null}
          </div>
          <div ref={endRef} />
        </div>
      )}
    </Panel>
  );
}
