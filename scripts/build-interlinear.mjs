#!/usr/bin/env node
/**
 * Builds the Greek and Hebrew interlinear that ships with the app.
 *
 *   node scripts/build-interlinear.mjs        # both testaments
 *   node scripts/build-interlinear.mjs nt     # just the Greek
 *
 * Output, in src-tauri/resources/:
 *   interlinear.tsv.gz   book \t chapter \t verse \t position \t original
 *                        \t transliteration \t gloss \t strongs \t morphology \t lemma
 *
 * # Where this comes from and what it costs
 *
 * STEPBible's TAHOT (Hebrew Old Testament) and TAGNT (Greek New Testament),
 * under **CC BY 4.0** — commercial use permitted with attribution, which is the
 * same obligation the Biblica translations already carry and is discharged the
 * same way, in About.
 *
 * Their files are the amalgamated editions: every word carries a disambiguated
 * Strong's number, a morphology code, a lemma and a contextual gloss, and is
 * marked with which manuscript editions contain it. We keep the first four and
 * drop the rest. The variant apparatus is real scholarship and the wrong tool
 * for an operator deciding what to put on a wall in the next four seconds.
 *
 * # Why it is one table rather than one per translation
 *
 * The original languages do not belong to a translation. A church reading the
 * KJV and a church reading the Yoruba Bible are looking at the same Greek, so
 * this is keyed by book, chapter and verse and joins to whatever is on screen.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "src-tauri/resources");

const BASE =
  "https://raw.githubusercontent.com/STEPBible/STEPBible-Data/master/Translators%20Amalgamated%20OT%2BNT";

/** Their files, split only because GitHub refuses a single one of this size. */
const SOURCES = {
  ot: [
    "TAHOT Gen-Deu - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT Jos-Est - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT Job-Sng - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT Isa-Mal - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
  ],
  nt: [
    "TAGNT Mat-Jhn - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
    "TAGNT Act-Rev - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
  ],
};

/**
 * Their book abbreviations against our canonical numbering.
 *
 * Written out rather than derived. Their scheme is close to OSIS but not it —
 * `Sng` for Song of Songs, `Jhn` for John — and a clever mapping that is right
 * for sixty of sixty-six is a mapping that silently drops six books.
 */
const BOOKS = {
  Gen: 1, Exo: 2, Lev: 3, Num: 4, Deu: 5, Jos: 6, Jdg: 7, Rut: 8,
  "1Sa": 9, "2Sa": 10, "1Ki": 11, "2Ki": 12, "1Ch": 13, "2Ch": 14,
  Ezr: 15, Neh: 16, Est: 17, Job: 18, Psa: 19, Pro: 20, Ecc: 21, Sng: 22,
  Isa: 23, Jer: 24, Lam: 25, Ezk: 26, Dan: 27, Hos: 28, Jol: 29, Amo: 30,
  Oba: 31, Jon: 32, Mic: 33, Nam: 34, Hab: 35, Zep: 36, Hag: 37, Zec: 38, Mal: 39,
  Mat: 40, Mrk: 41, Luk: 42, Jhn: 43, Act: 44, Rom: 45,
  "1Co": 46, "2Co": 47, Gal: 48, Eph: 49, Php: 50, Col: 51,
  "1Th": 52, "2Th": 53, "1Ti": 54, "2Ti": 55, Tit: 56, Phm: 57,
  Heb: 58, Jas: 59, "1Pe": 60, "2Pe": 61, "1Jn": 62, "2Jn": 63, "3Jn": 64,
  Jud: 65, Rev: 66,
};

async function fetchFile(name) {
  const url = `${BASE}/${encodeURIComponent(name)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.text();
}

/** `Βίβλος (Biblos)` → the word and how to say it. */
function splitOriginal(field) {
  const match = /^(.*?)\s*\((.*)\)\s*$/.exec(field.trim());
  return match ? [match[1].trim(), match[2].trim()] : [field.trim(), ""];
}

/**
 * Book.Chapter.Verse#Position — the only thing that marks a line as a word.
 *
 * Their files carry headers, licence text, separators and blank rows in the
 * same stream as the data, so this is what separates them.
 */
function locate(reference) {
  const at = /^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)#(\d+)/.exec(reference ?? "");
  if (!at) return null;
  const book = BOOKS[at[1]];
  return book ? [book, Number(at[2]), Number(at[3]), Number(at[4])] : null;
}

/**
 * The Greek, whose columns pack more into fewer.
 *
 *   1  Βίβλος (Biblos)   word and transliteration together
 *   2  [The] book        contextual gloss
 *   3  G0976=N-NSF       Strong's and morphology, joined by =
 *   4  βίβλος=book       lemma and its plain meaning
 */
function parseGreek(cols) {
  const [original, transliteration] = splitOriginal(cols[1] ?? "");
  if (!original) return null;
  const [strongs = "", morphology = ""] = (cols[3] ?? "").split("=");
  return {
    original,
    transliteration,
    gloss: (cols[2] ?? "").trim(),
    strongs: strongs.trim(),
    morphology: morphology.trim(),
    lemma: ((cols[4] ?? "").split("=")[0] ?? "").trim(),
  };
}

/**
 * The Hebrew, which is laid out differently — and finding that out cost a
 * build that shipped every Hebrew word with no Strong's number at all.
 *
 *   1  בָּרָ֣א                   the word, with / between morphemes
 *   2  ba.Ra'                  transliteration in its own column
 *   3  he created              gloss
 *   4  {H1254A}                Strong's, sometimes braced or prefixed
 *   5  HVqp3ms                 ETCBC morphology
 *   8  H1254A                  the same Strong's, already cleaned
 *  11  {H1254A=בָּרָא=to create}  lemma, between the second and third =
 *
 * The `/` in column 1 is a morpheme boundary — prefix, root, suffix — and is
 * kept. "in/ beginning" is how the Hebrew actually works and flattening it
 * would throw away the thing an interlinear exists to show.
 */
function parseHebrew(cols) {
  const original = (cols[1] ?? "").trim();
  if (!original) return null;

  // Column 8 is the disambiguated form without braces; column 4 is the fallback
  // for the rows where it is empty.
  const strongs = (cols[8] || cols[4] || "").replace(/[{}]/g, "").trim();

  // `{H1254A=בָּרָא=to create}` — the dictionary form is the middle field.
  const lemma = ((cols[11] ?? "").replace(/[{}]/g, "").split("=")[1] ?? "").trim();

  return {
    original,
    transliteration: (cols[2] ?? "").trim(),
    gloss: (cols[3] ?? "").trim(),
    strongs,
    morphology: (cols[5] ?? "").trim(),
    lemma,
  };
}

/** One line into one word, or null for the lines that are not words. */
function parseLine(line, testament) {
  const cols = line.split("\t");
  const at = locate(cols[0]);
  if (!at) return null;

  const word = testament === "ot" ? parseHebrew(cols) : parseGreek(cols);
  if (!word) return null;

  return [
    ...at,
    word.original,
    word.transliteration,
    word.gloss,
    word.strongs,
    word.morphology,
    word.lemma,
  ];
}

async function main() {
  const which = process.argv[2];
  const wanted = which === "nt" || which === "ot" ? [which] : ["ot", "nt"];

  mkdirSync(outputDir, { recursive: true });
  const rows = [];

  for (const testament of wanted) {
    for (const name of SOURCES[testament]) {
      process.stdout.write(`${name.slice(0, 18).padEnd(20)} fetching…`);
      const text = await fetchFile(name);
      let kept = 0;
      for (const line of text.split("\n")) {
        const row = parseLine(line, testament);
        if (row) {
          rows.push(row);
          kept += 1;
        }
      }
      process.stdout.write(`\r${name.slice(0, 18).padEnd(20)} ${String(kept).padStart(7)} words\n`);
    }
  }

  // A word is identified by where it sits, so this order is also the order it
  // is read in — which means the app can stream a verse without sorting.
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

  /*
   * Seventeen references carry two words at the same position, and the first
   * one wins.
   *
   * They are versification collisions: 2 Kings 25:3 and a handful like it are
   * numbered differently in the Hebrew and English traditions, and STEPBible
   * carries both mappings in the same stream. Keeping both would interleave two
   * numbering systems inside one verse — "in the month / on day nine / the
   * fourth / of the month" — which reads as nonsense rather than as scholarship.
   *
   * Seventeen out of four hundred thousand, all in the Old Testament, and the
   * first mapping is the one their file leads with. Counted rather than
   * silently dropped, so if a future edition changes this the number moves and
   * somebody asks why.
   */
  let dropped = 0;
  {
    // Filtered in place rather than into a second array and spread back: a
    // spread of four hundred thousand arguments overflows the call stack, which
    // is a spectacular way to fail at the last step of a five-minute build.
    let keep = 0;
    for (let at = 0; at < rows.length; at += 1) {
      const previous = rows[keep - 1];
      const row = rows[at];
      if (previous && previous[0] === row[0] && previous[1] === row[1] &&
          previous[2] === row[2] && previous[3] === row[3]) {
        dropped += 1;
        continue;
      }
      rows[keep] = row;
      keep += 1;
    }
    rows.length = keep;
  }
  if (dropped > 0) {
    console.log(`${dropped} versification duplicates dropped, keeping the first of each.`);
  }

  const books = new Set(rows.map((row) => row[0]));
  if (rows.length < 100_000 && wanted.length === 2) {
    throw new Error(`only ${rows.length} words — expected both testaments`);
  }

  const body = `${rows.map((row) => row.join("\t")).join("\n")}\n`;
  const packed = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
  writeFileSync(resolve(outputDir, "interlinear.tsv.gz"), packed);

  console.log(
    `\n${rows.length.toLocaleString()} words across ${books.size} books` +
      `  →  ${(packed.length / 1024 / 1024).toFixed(1)} MB packed` +
      `\nchecksum ${createHash("sha256").update(body).digest("hex").slice(0, 16)}`,
  );
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
