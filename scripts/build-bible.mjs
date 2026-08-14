#!/usr/bin/env node
/**
 * Builds the translation files Pulpitry bundles and imports.
 *
 *   node scripts/build-bible.mjs            # all translations
 *   node scripts/build-bible.mjs KJV ASV    # just these
 *
 * Output, in src-tauri/resources/:
 *   <ID>.tsv.gz          gzipped, one verse per line:
 *                        bookNumber \t bookName \t chapter \t verse \t text
 *   translations.json    manifest the Rust side reads at startup
 *
 * Every translation here is public domain. Copyrighted texts (NIV, ESV, NKJV,
 * NLT, NASB, LEB, MKJV...) cannot be redistributed and are deliberately absent.
 *
 * Generated files are committed, so a normal build needs no network access.
 * Re-run this only to refresh or to add a translation.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "src-tauri/resources");

const ARUL = "https://raw.githubusercontent.com/aruljohn/Bible-kjv/master";
const SCROLL = "https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/json";
/*
 * The World English Bible, one file per book.
 *
 * Its own source because scrollmapper does not carry it, and it is the one
 * modern-English translation here that is unambiguously public domain --
 * eBible.org, which distributes it for the translators, says so in as many
 * words. Several modern translations sitting in "public domain" collections
 * elsewhere (LEB, MKJV, LITV) are freely readable but still under copyright,
 * and shipping one of those is the mistake this set exists to avoid.
 */
const WEB_JSON = "https://raw.githubusercontent.com/TehShrike/world-english-bible/master/json";

/*
 * The Free Use Bible API, for everything that is not English.
 *
 * 1,256 translations, and the reason it is trusted here rather than any of the
 * larger collections is what it leaves out: it carries eBible.org's corpus
 * filtered to the texts eBible marks redistributable, and none of the 257 it
 * does not. That was checked rather than assumed -- every one of its entries
 * was matched against eBible's own catalogue and not one blocked text appears.
 *
 * One request per translation: `/complete.json` is the whole Bible, where the
 * per-chapter route would be about twelve hundred.
 */
const HELLOAO = "https://bible.helloao.org/api";

/**
 * The bundled set.
 *
 * `order` decides import order, and the first entry is imported first so the
 * operator has something usable within a second or two of first launch.
 *
 * KJV comes from a different source on purpose: scrollmapper's KJV folds the
 * psalm superscriptions into verse 1 and loses the small-caps LORD convention,
 * both of which matter for a translation people read aloud from.
 */
const TRANSLATIONS = [
  { id: "KJV", name: "King James Version", year: 1611, source: "arul" },
  { id: "ASV", name: "American Standard Version", year: 1901, source: "scroll", file: "ASV" },
  { id: "BSB", name: "Berean Standard Bible", year: 2023, source: "scroll", file: "BSB" },
  { id: "NHEB", name: "New Heart English Bible", year: 2010, source: "scroll", file: "NHEB" },
  { id: "BBE", name: "Bible in Basic English", year: 1949, source: "scroll", file: "BBE" },
  { id: "YLT", name: "Young's Literal Translation", year: 1898, source: "scroll", file: "YLT" },
  { id: "DARBY", name: "Darby Translation", year: 1890, source: "scroll", file: "Darby" },
  { id: "WEBSTER", name: "Webster's Bible", year: 1833, source: "scroll", file: "Webster" },
  { id: "GENEVA", name: "Geneva Bible", year: 1599, source: "scroll", file: "Geneva1599" },
  { id: "DRC", name: "Douay-Rheims (Challoner)", year: 1752, source: "scroll", file: "DRC" },
  { id: "WEB", name: "World English Bible", year: 2000, source: "web" },

  /*
   * Modern English, which the set above is short of.
   *
   * Everything before these is 1901 or earlier apart from three, and a
   * congregation reading Jacobean English is a congregation working harder
   * than it needs to. FBV is plain contemporary English; MSB is the Berean
   * project's 2024 majority-text edition; WEBU is the World English Bible
   * brought up to date.
   *
   * The NET Bible is deliberately absent and is the one worth explaining. Its
   * licence is generous about ministry use and explicit that the text "cannot
   * be bundled with paid products" -- commercial redistribution goes through
   * HarperCollins. That is a conversation to have on purpose, not a flag to
   * read off a catalogue, and until somebody has it the text stays out.
   */
  { id: "FBV", name: "Free Bible Version", year: 2023, source: "helloao", file: "eng_fbv",
    licence: "CC BY-SA 4.0", attribution: "Free Bible Version © Dr. Jonathan Gallagher" },
  { id: "MSB", name: "Majority Standard Bible", year: 2024, source: "helloao", file: "eng_msb" },
  { id: "WEBU", name: "World English Bible (Updated)", year: 2022, source: "helloao", file: "eng_webu" },

  /*
   * The languages the congregations actually sing and preach in.
   *
   * These matter more than a twelfth English translation. A Yoruba service
   * reading from an English Bible on the wall is the ordinary situation this
   * fixes, and all three are Biblica's own open editions -- the NIV's publisher,
   * released for free redistribution, so there is nothing here to clear.
   *
   * Book names stay English on purpose. The reference parser, the detector and
   * every cross-translation lookup key on them, and a Bible whose books are
   * named in Yoruba would be a Bible the microphone could not find a verse in.
   * The verse text is the part that goes on the wall, and that is in Yoruba.
   */
  { id: "YOR", name: "Bíbélì Mímọ́ (Yoruba)", year: 2017, source: "helloao", file: "yor_bib",
    licence: "CC BY-SA 4.0", attribution: "Biblica® open edition © Biblica, Inc." },
  { id: "IBO", name: "Baịbụlụ Nsọ (Igbo)", year: 2018, source: "helloao", file: "ibo_bib",
    licence: "CC BY-SA 4.0", attribution: "Biblica® open edition © Biblica, Inc." },
  { id: "HAU", name: "Littafi Mai Tsarki (Hausa)", year: 2020, source: "helloao", file: "hau_bib",
    licence: "CC BY-SA 4.0", attribution: "Biblica® open edition © Biblica, Inc." },
  { id: "SWH", name: "Biblia Takatifu (Swahili)", year: 2018, source: "helloao", file: "swh_bib",
    licence: "CC BY-SA 4.0", attribution: "Biblica® open edition © Biblica, Inc." },
  { id: "TWI", name: "Twi Bible (Akuapem)", year: 2020, source: "helloao", file: "twi_aka",
    licence: "CC BY-SA 4.0", attribution: "Biblica® open edition © Biblica, Inc." },
  { id: "FRA", name: "Louis Segond (Français)", year: 1910, source: "helloao", file: "fra_lsg" },
  { id: "SPA", name: "Reina Valera (Español)", year: 1909, source: "helloao", file: "spa_r09" },
  { id: "POR", name: "Bíblia Livre (Português)", year: 2018, source: "helloao", file: "por_blj" },
];

/** Canonical order and display names. Also the repo filename for the KJV source. */
const BOOKS = [
  ["Genesis", "Genesis"], ["Exodus", "Exodus"], ["Leviticus", "Leviticus"],
  ["Numbers", "Numbers"], ["Deuteronomy", "Deuteronomy"], ["Joshua", "Joshua"],
  ["Judges", "Judges"], ["Ruth", "Ruth"], ["1 Samuel", "1Samuel"], ["2 Samuel", "2Samuel"],
  ["1 Kings", "1Kings"], ["2 Kings", "2Kings"], ["1 Chronicles", "1Chronicles"],
  ["2 Chronicles", "2Chronicles"], ["Ezra", "Ezra"], ["Nehemiah", "Nehemiah"],
  ["Esther", "Esther"], ["Job", "Job"], ["Psalms", "Psalms"], ["Proverbs", "Proverbs"],
  ["Ecclesiastes", "Ecclesiastes"], ["Song of Solomon", "SongofSolomon"], ["Isaiah", "Isaiah"],
  ["Jeremiah", "Jeremiah"], ["Lamentations", "Lamentations"], ["Ezekiel", "Ezekiel"],
  ["Daniel", "Daniel"], ["Hosea", "Hosea"], ["Joel", "Joel"], ["Amos", "Amos"],
  ["Obadiah", "Obadiah"], ["Jonah", "Jonah"], ["Micah", "Micah"], ["Nahum", "Nahum"],
  ["Habakkuk", "Habakkuk"], ["Zephaniah", "Zephaniah"], ["Haggai", "Haggai"],
  ["Zechariah", "Zechariah"], ["Malachi", "Malachi"], ["Matthew", "Matthew"],
  ["Mark", "Mark"], ["Luke", "Luke"], ["John", "John"], ["Acts", "Acts"],
  ["Romans", "Romans"], ["1 Corinthians", "1Corinthians"], ["2 Corinthians", "2Corinthians"],
  ["Galatians", "Galatians"], ["Ephesians", "Ephesians"], ["Philippians", "Philippians"],
  ["Colossians", "Colossians"], ["1 Thessalonians", "1Thessalonians"],
  ["2 Thessalonians", "2Thessalonians"], ["1 Timothy", "1Timothy"], ["2 Timothy", "2Timothy"],
  ["Titus", "Titus"], ["Philemon", "Philemon"], ["Hebrews", "Hebrews"], ["James", "James"],
  ["1 Peter", "1Peter"], ["2 Peter", "2Peter"], ["1 John", "1John"], ["2 John", "2John"],
  ["3 John", "3John"], ["Jude", "Jude"], ["Revelation", "Revelation"],
];

/** Spellings that normalisation alone will not reconcile. */
const BOOK_ALIASES = new Map([
  ["revelationofjohn", "revelation"],
  ["revelationofstjohnthedivine", "revelation"],
  ["therevelation", "revelation"],
  ["songofsongs", "songofsolomon"],
  ["canticles", "songofsolomon"],
  ["canticleofcanticles", "songofsolomon"],
  ["psalm", "psalms"],
  ["theacts", "acts"],
  ["actsoftheapostles", "acts"],
  ["qoheleth", "ecclesiastes"],
  ["ecclesiasticus", null], // Apocrypha — not Ecclesiastes, must not be confused for it
  ["canticle", "songofsolomon"],
]);

/**
 * Normalises a book name: Roman ordinals become digits, then everything but
 * letters and digits is dropped. "I Samuel" and "1 Samuel" both become
 * "1samuel".
 */
function normalizeBook(name) {
  const tokens = String(name).trim().toLowerCase().split(/\s+/);
  const romans = { i: "1", ii: "2", iii: "3" };
  const head = tokens[0];
  if (head && head in romans) tokens[0] = romans[head];
  return tokens.join("").replace(/[^a-z0-9]/g, "");
}

const CANONICAL_BY_KEY = new Map(
  BOOKS.map(([name], index) => [normalizeBook(name), index + 1]),
);

/** @returns {number|null} 1-based canonical book number, or null if not one of the 66. */
function canonicalBookNumber(name) {
  const key = normalizeBook(name);
  if (CANONICAL_BY_KEY.has(key)) return CANONICAL_BY_KEY.get(key);
  if (BOOK_ALIASES.has(key)) {
    const target = BOOK_ALIASES.get(key);
    return target ? (CANONICAL_BY_KEY.get(target) ?? null) : null;
  }
  return null;
}

/**
 * Declared, translation-specific repairs for defects in the upstream text.
 *
 * These are deliberately narrow. Scripture is read aloud from this app, so the
 * bar is that a repair must be provably mechanical — a lost separator with a
 * single unambiguous reading — never an editorial judgement about wording.
 */
const REPAIRS = {
  // The source dropped the space before the divine name, giving "AndGod said"
  // and "In the beginningGod created". 3,681 occurrences, and the following
  // word is "God" or "Godhead" in every single one, so the reading is not in
  // question. No English word ends in "...God", so this cannot over-match.
  DARBY: [[/([a-z])(God)/g, "$1 $2"]],
};

/** Verses are one line each, so nothing may contain a tab or a newline. */
function clean(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function repair(id, text) {
  const rules = REPAIRS[id];
  if (!rules) return text;
  let out = text;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Flags text where a lowercase letter runs straight into an uppercase one.
 * That is nearly always a separator lost in conversion, and it is invisible
 * until someone reads it off a projector mid-service.
 */
function countLostSeparators(rows) {
  let total = 0;
  const examples = [];
  for (const row of rows) {
    const matches = row[4].match(/[a-z][A-Z][a-z]/g);
    if (!matches) continue;
    total += matches.length;
    if (examples.length < 5) examples.push(`${row[1]} ${row[2]}:${row[3]} — ${row[4].slice(0, 70)}`);
  }
  return { total, examples };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** aruljohn: one file per book, already in canonical naming. */
async function loadArul(id) {
  const rows = [];
  for (const [index, entry] of BOOKS.entries()) {
    const [name, file] = entry;
    const data = await fetchJson(`${ARUL}/${file}.json`);
    for (const chapter of data.chapters) {
      for (const verse of chapter.verses) {
        rows.push([index + 1, name, Number(chapter.chapter), Number(verse.verse), repair(id, clean(verse.text))]);
      }
    }
  }
  return { rows, skipped: [] };
}

/** scrollmapper: one file per translation, book names vary by edition. */
async function loadScroll(id, file) {
  const data = await fetchJson(`${SCROLL}/${file}.json`);
  const rows = [];
  const skipped = new Set();

  for (const book of data.books) {
    const number = canonicalBookNumber(book.name);
    if (number === null) {
      // Deuterocanon and apocrypha in some editions; outside the 66-book canon
      // the rest of the app assumes.
      skipped.add(book.name);
      continue;
    }
    const name = BOOKS[number - 1][0];
    for (const chapter of book.chapters) {
      for (const verse of chapter.verses) {
        const text = repair(id, clean(verse.text));
        if (!text) continue;
        rows.push([number, name, Number(chapter.chapter), Number(verse.verse), text]);
      }
    }
  }
  return { rows, skipped: [...skipped] };
}

/**
 * The World English Bible, assembled from one file per book.
 *
 * A verse arrives as one or more "paragraph text" entries -- the translation
 * breaks mid-verse at paragraph and poetry boundaries -- so segments sharing a
 * chapter and verse are joined in the order they appear. Taking only the first
 * would silently truncate every verse that spans a break.
 */
async function loadWeb() {
  const rows = [];

  for (let number = 1; number <= BOOKS.length; number++) {
    const name = BOOKS[number - 1][0];
    // The files are the book name lowercased with everything else stripped:
    // "1 Samuel" becomes 1samuel.json.
    const file = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const entries = await fetchJson(`${WEB_JSON}/${file}.json`);

    const verses = new Map();
    for (const entry of entries) {
      if (typeof entry.verseNumber !== "number" || typeof entry.value !== "string") continue;
      const key = `${entry.chapterNumber}:${entry.verseNumber}`;
      const existing = verses.get(key);
      verses.set(key, existing ? `${existing} ${entry.value}` : entry.value);
    }

    for (const [key, value] of verses) {
      const [chapter, verse] = key.split(":").map(Number);
      const text = repair("WEB", clean(value));
      if (!text) continue;
      rows.push([number, name, chapter, verse, text]);
    }
  }

  return { rows, skipped: [] };
}

/**
 * One translation from the Free Use Bible API.
 *
 * The whole Bible arrives as a single document: books, each with chapters, each
 * with a `content` array that mixes headings and verses. Only the verses are
 * wanted, and a verse's own content is itself an array -- plain strings beside
 * objects carrying `text` plus markup we do not use, which is how the words of
 * Jesus are marked. Flattening both is the whole of the work.
 */
async function loadHelloAo(file) {
  const document = await fetchJson(`${HELLOAO}/${file}/complete.json`);
  const rows = [];
  const skipped = [];

  for (const book of document.books ?? []) {
    // `order` is the canonical position, and these are 66-book Bibles. Anything
    // outside that is apocryphal and is dropped rather than renumbered.
    const number = book.order;
    if (!Number.isInteger(number) || number < 1 || number > BOOKS.length) {
      skipped.push(book.commonName ?? book.id);
      continue;
    }
    const name = BOOKS[number - 1][0];

    for (const entry of book.chapters ?? []) {
      /*
       * One level deeper than the per-chapter route, which returns the chapter
       * itself. Here each element wraps it alongside audio links -- and reading
       * it at the wrong depth yields no verses at all rather than an error,
       * which is how this was first written and how the validator caught it.
       */
      const chapter = entry.chapter ?? entry;

      for (const item of chapter.content ?? []) {
        if (item?.type !== "verse" || typeof item.number !== "number") continue;

        const text = clean(
          (item.content ?? [])
            .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
            .join(" "),
        );
        if (!text) continue;
        rows.push([number, name, chapter.number, item.number, text]);
      }
    }
  }

  return { rows, skipped };
}

function validate(id, rows) {
  if (rows.length < 25_000) {
    throw new Error(`${id}: only ${rows.length} verses — expected a complete Bible`);
  }
  const books = new Set(rows.map((row) => row[0]));
  if (books.size !== 66) {
    throw new Error(`${id}: covers ${books.size} of 66 books`);
  }
  for (const row of rows) {
    if (!Number.isInteger(row[2]) || !Number.isInteger(row[3]) || row[2] < 1 || row[3] < 1) {
      throw new Error(`${id}: bad chapter/verse in ${row[1]} ${row[2]}:${row[3]}`);
    }
  }

  // A handful of these are genuine (run-together proper nouns such as
  // "EleloheIsrael"); hundreds mean the conversion lost its separators.
  const lost = countLostSeparators(rows);
  if (lost.total > 25) {
    throw new Error(
      `${id}: ${lost.total} suspected lost separators — the source needs a repair rule.\n` +
        lost.examples.map((line) => `    ${line}`).join("\n"),
    );
  }
  if (lost.total > 0) {
    process.stdout.write(`\r${id.padEnd(8)} note: ${lost.total} run-together words (within tolerance)\n`);
  }
}

async function main() {
  const requested = process.argv.slice(2);
  const selected = requested.length
    ? TRANSLATIONS.filter((entry) => requested.includes(entry.id))
    : TRANSLATIONS;

  if (selected.length === 0) {
    throw new Error(`no known translation among: ${requested.join(", ")}`);
  }

  mkdirSync(outputDir, { recursive: true });
  const manifest = [];

  for (const entry of selected) {
    process.stdout.write(`${entry.id.padEnd(8)} fetching…`);
    const { rows, skipped } =
      entry.source === "arul"
        ? await loadArul(entry.id)
        : entry.source === "web"
          ? await loadWeb()
          : entry.source === "helloao"
            ? await loadHelloAo(entry.file)
            : await loadScroll(entry.id, entry.file);

    validate(entry.id, rows);
    rows.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[3] - b[3]);

    const body = `${rows.map((row) => row.join("\t")).join("\n")}\n`;
    const file = `${entry.id}.tsv.gz`;
    // Level 9: written once here, read on every first launch.
    const packed = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
    writeFileSync(resolve(outputDir, file), packed);

    manifest.push({
      id: entry.id,
      name: entry.name,
      year: entry.year,
      file,
      /*
       * Only where there is one. A public-domain text carries no condition and
       * an empty "licence: public domain" on eleven entries would bury the five
       * that do -- and it is those five the About dialog is obliged to name.
       */
      ...(entry.licence ? { licence: entry.licence, attribution: entry.attribution } : {}),
      verseCount: rows.length,
      // Lets the app notice a corrected text on upgrade. Verse counts alone
      // would not: fixing wording changes no counts.
      checksum: createHash("sha256").update(body).digest("hex").slice(0, 16),
    });

    const megabytes = (packed.length / 1024 / 1024).toFixed(1);
    process.stdout.write(
      `\r${entry.id.padEnd(8)} ${String(rows.length).padStart(6)} verses  ${megabytes} MB` +
        (skipped.length ? `  (skipped ${skipped.length} non-canonical: ${skipped.slice(0, 3).join(", ")}…)` : "") +
        "\n",
    );
  }

  // Merge with any previously built translations so a partial run does not
  // drop the rest from the manifest.
  const manifestPath = resolve(outputDir, "translations.json");
  let existing = [];
  try {
    const { readFileSync } = await import("node:fs");
    existing = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    /* first run */
  }
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of manifest) byId.set(entry.id, entry);

  const order = new Map(TRANSLATIONS.map((entry, index) => [entry.id, index]));
  const merged = [...byId.values()].sort(
    (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99),
  );

  writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`\nmanifest: ${merged.length} translations -> ${manifestPath}`);
}

await main();
