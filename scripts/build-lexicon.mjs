#!/usr/bin/env node
/**
 * Builds the Strong's lexicon that ships with the app.
 *
 *   node scripts/build-lexicon.mjs
 *
 * Output, in src-tauri/resources/:
 *   lexicon.tsv.gz   strongs \t lemma \t transliteration \t partOfSpeech \t gloss \t definition
 *
 * # What this is, precisely
 *
 * STEPBible's TBESG and TBESH — "Translators Brief lexicon of Extended
 * Strongs" for Greek and Hebrew, **CC BY 4.0**, keyed by the same extended
 * Strong's numbers the interlinear already carries. So a word on the operator's
 * screen leads straight to its entry with no matching to do.
 *
 * The entries are substantial rather than one-line glosses: derived from
 * Abbott-Smith for Greek, which is the standard brief lexicon and covers the
 * ground Thayer's is usually reached for — inflections, Septuagint usage,
 * senses numbered, references. Where somebody wants Thayer's specifically, that
 * is a different book and would have to be sourced separately; this is not it,
 * and the panel should not pretend otherwise.
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

/** HTML out, readable text in. Never rendered, so never trusted. */
function plain(markup) {
  return markup
    .replace(/<ref='[^']*'>/g, "")
    .replace(/<\/ref>/g, "")
    .replace(/<BR\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
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

  console.log(
    `\n${rows.length.toLocaleString()} entries  →  ${(packed.length / 1024 / 1024).toFixed(1)} MB packed`,
  );
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
