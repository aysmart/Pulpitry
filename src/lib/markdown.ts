/**
 * The small subset of Markdown a summary uses.
 *
 * Deliberately the same subset the exporter understands (`exports.rs`): the
 * model is asked for headings, bullets, bold, italics and paragraphs, and
 * nothing else is promised. Keeping the reader and the writers agreed means the
 * PDF a church sends out says what the operator saw on screen.
 *
 * Written here rather than pulled in, because a Markdown library is a large
 * dependency for six constructs, and the one thing that matters — that display
 * and export agree — is not something a library can promise.
 */

export type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "bullets"; items: Span[][] };

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) blocks.push({ kind: "paragraph", spans: parseSpans(text) });
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();

    if (!line) {
      flush();
      continue;
    }

    const [, hashes, headingText] = /^(#{1,6})\s+(.*)$/.exec(line) ?? [];
    if (hashes && headingText?.trim()) {
      flush();
      blocks.push({
        kind: "heading",
        level: hashes.length,
        spans: parseSpans(headingText.trim()),
      });
      continue;
    }

    const [, bulletText] = /^[-*+]\s+(.*)$/.exec(line) ?? [];
    if (bulletText !== undefined) {
      flush();
      // Consecutive bullets are one list, so they can be marked up as one and
      // spaced as one.
      const last = blocks[blocks.length - 1];
      const item = parseSpans(bulletText.trim());
      if (last?.kind === "bullets") last.items.push(item);
      else blocks.push({ kind: "bullets", items: [item] });
      continue;
    }

    // A single newline inside a paragraph is a space, not a break.
    paragraph.push(line);
  }

  flush();
  return blocks;
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Splits a run of text on its emphasis markers.
 *
 * `**` and `__` are bold, single `*` and `_` italic. An unclosed marker is
 * treated as the character it is, so a stray asterisk costs a reader an
 * asterisk rather than swallowing the rest of the sentence.
 *
 * An underscore inside a word is a literal underscore, as CommonMark has it:
 * without that rule a file name in a summary comes out italicised.
 */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  let plain = "";
  let index = 0;

  const push = (span: Span) => {
    if (span.text) spans.push(span);
  };

  while (index < text.length) {
    const char = text[index];
    if (char !== "*" && char !== "_") {
      plain += char;
      index += 1;
      continue;
    }

    const double = text[index + 1] === char;
    const marker = double ? char + char : char;
    const close = text.indexOf(marker, index + marker.length);

    // Nothing between the markers, or no closing one: it is punctuation.
    if (close === -1 || close === index + marker.length) {
      plain += char;
      index += 1;
      continue;
    }

    const intraword =
      char === "_" &&
      (WORD.test(text[index - 1] ?? "") || WORD.test(text[close + marker.length] ?? ""));
    if (intraword) {
      plain += char;
      index += 1;
      continue;
    }

    push({ text: plain });
    plain = "";
    const inner = text.slice(index + marker.length, close);
    push(double ? { text: inner, bold: true } : { text: inner, italic: true });
    index = close + marker.length;
  }

  push({ text: plain });
  return spans;
}

/** The same text with its markers removed — for titles, tooltips and search. */
export function plainText(markdown: string): string {
  return parseMarkdown(markdown)
    .map((block) =>
      block.kind === "bullets"
        ? block.items.map((item) => item.map((span) => span.text).join("")).join("\n")
        : block.spans.map((span) => span.text).join(""),
    )
    .join("\n");
}
