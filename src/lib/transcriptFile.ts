import type { TranscriptLine } from "./useTranscript";

export interface TranscriptContext {
  /** Microphone the session was captured on, if known. */
  device?: string | null;
  /** Recognition language, e.g. en-NG. */
  language?: string | null;
}

const stamp = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** `pulpitry-transcript-2026-08-02-1432.txt` — sorts chronologically. */
export function defaultFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `pulpitry-transcript-${date}-${time}.txt`;
}

/**
 * Renders the transcript as plain text.
 *
 * Timestamped, one line per confirmed segment, matching what the operator saw
 * on screen. A short header records when and how it was captured, because a
 * transcript filed away months later is worth little without that.
 */
export function formatTranscript(
  lines: TranscriptLine[],
  context: TranscriptContext = {},
): string {
  const first = lines[0];
  const captured = first ? new Date(first.at) : new Date();

  const header = ["Pulpitry transcript", longDate.format(captured)];
  const detail = [
    context.language ? `Language: ${context.language}` : null,
    context.device ? `Microphone: ${context.device}` : null,
    `${lines.length} ${lines.length === 1 ? "segment" : "segments"}`,
  ].filter(Boolean);
  header.push(detail.join(" · "));

  const body = lines.map((line) => `[${stamp.format(line.at)}] ${line.text}`);

  // Trailing newline: some editors and shells expect one at end of file.
  return `${header.join("\n")}\n\n${body.join("\n")}\n`;
}
