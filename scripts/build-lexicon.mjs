#!/usr/bin/env node
/**
 * Builds the Strong's lexicon that ships with the app.
 *
 *   node scripts/build-lexicon.mjs
 *
 * Output, in src-tauri/resources/:
 *   lexicon.tsv.gz   strongs \t lemma \t transliteration \t partOfSpeech \t gloss
 *                    \t definition \t thayer
 *
 * # What this is, precisely
 *
 * STEPBible's TBESG and TBESH — "Translators Brief lexicon of Extended
 * Strongs" for Greek and Hebrew, **CC BY 4.0**, keyed by the same extended
 * Strong's numbers the interlinear already carries. So a word on the operator's
 * screen leads straight to its entry with no matching to do.
 *
 * The entries are substantial rather than one-line glosses: derived from
 * Abbott-Smith for Greek — inflections, Septuagint usage, senses numbered,
 * references.
 *
 * # And Thayer's, which is a different book
 *
 * Thayer's Greek-English Lexicon of the New Testament (1889) is public domain
 * and is fetched separately, from an edition already coded to Strong's numbers.
 * It is fuller and more discursive than the brief lexicon and it is what people
 * mean when they ask for Thayer's, so it is kept as its own field rather than
 * merged into one — a reader should know which book they are reading.
 *
 * Greek only. Thayer's is a New Testament lexicon and has nothing to say about
 * Hebrew, so every Hebrew entry carries the brief definition alone.
 *
 * **Their numbers are unpadded.** Thayer's edition writes `G26` where the
 * interlinear writes `G0026`, and joining the two without noticing produces a
 * lexicon in which almost nothing matches.
 *
 * # The markup is stripped, and the cross-references with it
 *
 * Entries arrive as HTML: `<b>`, `<BR />`, and `<ref='Mat.5.43'>Mat.5:43;</ref>`
 * for every citation. The tags go and the reference text stays, because a
 * reference an operator can read is worth keeping and a link they cannot follow
 * is not. Rendering the HTML was the alternative and it means trusting a
 * third-party file to contain no script, in a window that can reach the
 * filesystem.
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "src-tauri/resources");

const BASE = "https://raw.githubusercontent.com/STEPBible/STEPBible-Data/master/Lexicons";
const SOURCES = [
  "TBESG - Translators Brief lexicon of Extended Strongs for Greek - STEPBible.org CC BY.txt",
  "TBESH - Translators Brief lexicon of Extended Strongs for Hebrew - STEPBible.org CC BY.txt",
];

const THAYER =
  "https://raw.githubusercontent.com/EveryPromiseBible/Every-Promise-Thayers/master/thayers.html";

/**
 * Thayer's, keyed the way the interlinear keys things.
 *
 * Their file is one `<article class="e">` per entry with the Strong's number in
 * a `<span class="sn">`, unpadded. Parsed with a regular expression rather than
 * a DOM library because the shape is regular and the alternative is a
 * dependency to read one file at build time.
 */
async function fetchThayer() {
  const response = await fetch(THAYER);
  if (!response.ok) throw new Error(`Thayer's: HTTP ${response.status}`);
  const html = await response.text();

  const entries = new Map();
  const article = /<article class="e"[^>]*>([\s\S]*?)<\/article>/g;
  let found;
  while ((found = article.exec(html)) !== null) {
    const body = found[1];
    const number = /<span class="sn">([GH])(\d+)<\/span>/.exec(body);
    if (!number) continue;

    // G26 -> G0026, so it meets the interlinear on its own terms.
    const strongs = `${number[1]}${number[2].padStart(4, "0")}`;
    const text = plain(body.replace(/<div class="gk">[\s\S]*?<\/div>/, ""));
    if (text) entries.set(strongs, text);
  }
  return entries;
}

/** The named entities their file actually uses, and the ones any HTML uses. */
const NAMED = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/**
 * `&#x27;` back into an apostrophe.
 *
 * Their file escapes quotes numerically, which the app has no reason to
 * understand — it renders as text, so an undecoded entity reaches the operator
 * as literal `&#x27;` in the middle of a sentence. It was in 2,218 of the 5,521
 * Thayer's entries.
 *
 * One pass, not one replace per entity: decoding `&amp;` separately would turn
 * a literal `&amp;#x27;` — the correct escaping of the text "&#x27;" — into an
 * apostrophe on the second pass.
 */
function entities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Anything outside Unicode, or a lone surrogate, is left as it was
      // rather than turned into a replacement character.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** HTML out, readable text in. Never rendered, so never trusted. */
function plain(markup) {
  return entities(
    markup
      .replace(/<ref='[^']*'>/g, "")
      .replace(/<\/ref>/g, "")
      .replace(/<BR\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    // Their entries are laid out with __1. __2. as sense numbers. Kept, with
    // the underscores turned into something a person reads.
    .replace(/__(\d+)\./g, "\n$1.")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  const rows = [];
  const seen = new Set();

  process.stdout.write("Thayer  fetching…");
  const thayer = await fetchThayer();
  process.stdout.write(`\rThayer  ${String(thayer.size).padStart(6)} entries\n`);

  for (const name of SOURCES) {
    process.stdout.write(`${name.slice(0, 6)} fetching…`);
    const response = await fetch(`${BASE}/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const text = await response.text();

    let kept = 0;
    for (const line of text.split("\n")) {
      const cols = line.split("\t");
      const strongs = (cols[0] ?? "").trim();

      // A real entry starts with a Strong's number and nothing else does.
      if (!/^[GH]\d{4}/.test(strongs) || seen.has(strongs)) continue;

      const definition = plain(cols[7] ?? "");
      const gloss = (cols[6] ?? "").trim();
      if (!gloss && !definition) continue;

      seen.add(strongs);
      rows.push([
        strongs,
        (cols[3] ?? "").trim(),
        (cols[4] ?? "").trim(),
        (cols[5] ?? "").trim(),
        gloss,
        // Tabs and newlines would break the row; the definition keeps its
        // paragraphs as a marker the app turns back into line breaks.
        definition.replace(/\t/g, " ").replace(/\n/g, "¶"),
        (thayer.get(strongs) ?? "").replace(/\t/g, " ").replace(/\n/g, "¶"),
      ]);
      kept += 1;
    }
    process.stdout.write(`\r${name.slice(0, 6)} ${String(kept).padStart(6)} entries\n`);
  }

  rows.sort((a, b) => a[0].localeCompare(b[0]));

  if (rows.length < 10_000) {
    throw new Error(`only ${rows.length} entries — expected both lexicons`);
  }

  const body = `${rows.map((row) => row.join("\t")).join("\n")}\n`;
  const packed = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
  writeFileSync(resolve(outputDir, "lexicon.tsv.gz"), packed);

  const withThayer = rows.filter((row) => row[6]).length;
  console.log(
    `\n${rows.length.toLocaleString()} entries, ${withThayer.toLocaleString()} with Thayer's` +
      `  →  ${(packed.length / 1024 / 1024).toFixed(1)} MB packed`,
  );
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
