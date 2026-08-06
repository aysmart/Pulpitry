#!/usr/bin/env node
/**
 * Builds the hymn library Pulpitry bundles and imports.
 *
 *   node scripts/build-hymns.mjs
 *
 * Output, in src-tauri/resources/:
 *   hymns.json.gz   gzipped array of hymns, each with its sections and the
 *                   provenance the Rust side stores alongside them
 *   hymns.json      manifest the Rust side reads at startup (counts, checksum)
 *
 * # Why this exists
 *
 * Nearly every worship song written in the last century is copyrighted, and
 * projecting one needs a licence the church buys -- CCLI or its equivalents.
 * Pulpitry deliberately does not integrate CCLI: it is a licence, not a
 * service an app can call, and the reporting obligation is the church's. What
 * an app can do is ship a library the church already has the right to use, so
 * that a new install is not an empty song list with a legal question attached.
 *
 * # Source
 *
 * The Open Hymnal Project (openhymnal.org), which exists to collect hymnody
 * that is public domain or otherwise freely distributable, and states the terms
 * for each score individually. Those statements are what this script filters
 * on -- see `wordsArePublicDomain` -- because the project's remit is broader
 * than ours: it accepts hymns whose authors granted permission, and permission
 * is not the same as public domain. Anything short of "the words are public
 * domain" is dropped rather than reinterpreted.
 *
 * # Why the ABC file rather than the lyrics page
 *
 * openhymnal.org publishes the same hymns three ways. The HTML lyrics page and
 * the ThML edition run each verse together into one paragraph, which is fine to
 * read and useless to project -- a slide needs to know where the lines break.
 * The ABC scores carry the words split across musical phrases, which is exactly
 * where a hymn's lines fall, so that is what this reads.
 *
 * Generated files are committed, so a normal build needs no network access.
 * Re-run this only to refresh the library.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "src-tauri/resources");

/** Every score in one file, words and music together. */
const ABC = "http://openhymnal.org/OpenHymnal2014.06.abc";

/**
 * The same edition marked up for CCEL, which the ABC scores are not: it carries
 * the scripture each hymn draws on. Matched back by title, and simply absent
 * for any hymn the two editions do not agree on the name of.
 */
const THML = "http://openhymnal.org/openhymnal.201406.xml";

/**
 * Whether the *words* are public domain.
 *
 * The words are the only part Pulpitry reproduces. A tune, an arrangement or a
 * setting can be under copyright without that mattering here, which is why
 * "words and music, public domain. Setting: copyright 2009 ..." passes: the
 * setting is the printed harmonisation, and we ship no music.
 *
 * The reverse -- "music and setting public domain. Words: copyright 2005 ..."
 * -- is the case this has to catch, and the one a looser check would let
 * through, because the string "public domain" appears in it.
 */
function wordsArePublicDomain(statement) {
  const text = statement.toLowerCase();

  // Someone holds the words. Nothing else in the sentence can undo that.
  if (/\b(words?|lyrics|text)\b[^.;]{0,40}copyright/.test(text)) return false;
  if (/copyright[^.;]{0,40}\b(words?|lyrics|text)\b/.test(text)) return false;

  // A grant of permission -- "may be freely reproduced" -- is a licence, and a
  // licence can be withdrawn or misread. Only an actual dedication counts.
  if (!text.includes("public domain")) return false;

  // "Melody, public domain" or "tune public domain" says nothing about the
  // words, so it is not an answer to the question being asked.
  const claim = text.slice(text.indexOf("public domain") - 60, text.indexOf("public domain"));
  if (/\b(melody|tune|music|setting)\b[^.;]*$/.test(claim) && !/\b(words?|lyrics|text)\b/.test(claim)) {
    return false;
  }

  return true;
}

/**
 * Turns one ABC `w:` line into plain text.
 *
 * ABC aligns lyrics to notes, so the line arrives as syllables: a trailing
 * hyphen means "the next token finishes this word", `~` is a space inside one
 * note's worth of lyric, and `*`, `_`, `|` and a lone `-` are all alignment
 * marks with nothing to say once the music is gone.
 */
export function readLyricLine(line) {
  let text = line.replace(/\\-/g, "\u0000"); // an escaped hyphen is a real one
  text = text.replace(/~/g, " ");

  const kept = text
    .split(/\s+/)
    // `*` marks a note with no syllable. It is usually a token of its own but
    // sometimes glued to the syllable before it ("Sa-*"), so it is stripped
    // rather than filtered -- filtering alone leaves the glued ones behind.
    .map((token) => token.replace(/\*/g, ""))
    .filter((token) => token && !["|", "_", "-"].includes(token));

  return kept
    .join(" ")
    .replace(/-\s+/g, "") // "Bles- sed" is one word
    .replace(/[_|]/g, " ")
    // A real hyphen is still spread across two notes, so the space beside it is
    // alignment rather than spacing: "loving\- kindness" is one word.
    .replace(/\u0000\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rejoins a word split across two lines.
 *
 * A long word can run past the end of a musical system, leaving one line ending
 * mid-syllable ("In the world be-") and the rest at the start of the next. That
 * is a fact about the printed score rather than about the hymn, and a slide
 * ending on "be-" reads as a mistake.
 */
export function joinBrokenWords(lines) {
  const joined = [];
  for (const line of lines) {
    const previous = joined[joined.length - 1];
    if (previous && previous.endsWith("-")) {
      const [head, ...rest] = line.split(" ");
      joined[joined.length - 1] = previous.slice(0, -1) + head;
      if (rest.length) joined.push(rest.join(" "));
      continue;
    }
    joined.push(line);
  }
  return joined;
}

/** Strips the "1." a first line carries to say which verse it belongs to. */
export function stripVerseNumber(line) {
  return line.replace(/^\s*\d+\s*[.)]\s*/, "").trim();
}

/**
 * Reads one ABC tune into a hymn.
 *
 * Lyrics appear as runs of `w:` lines following a voice line, one per verse in
 * order: the first `w:` of every run belongs to verse one, the second to verse
 * two, and so on. Collecting them that way reassembles each verse in the order
 * it is sung.
 */
export function readTune(tune) {
  const title = (tune.match(/^T:\s*(.+)$/m) || [])[1]?.trim();
  if (!title) return null;

  const credits = [...tune.matchAll(/^C:\s*(.+)$/gm)].map((match) => match[1].trim());
  const sources = [...tune.matchAll(/^S:\s*(.+)$/gm)].map((match) => match[1].trim());

  const verses = new Map();
  let run = [];
  const flush = () => {
    run.forEach((line, index) => {
      const number = index + 1;
      if (!verses.has(number)) verses.set(number, []);
      const text = readLyricLine(line);
      if (text) verses.get(number).push(text);
    });
    run = [];
  };

  for (const line of tune.split("\n")) {
    if (line.startsWith("w:")) run.push(line.slice(2));
    else if (/^\[?V:/.test(line)) flush();
  }
  flush();

  const sections = [...verses.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, lines]) => ({
      label: `Verse ${number}`,
      lines: joinBrokenWords(
        lines.map((line, index) => (index === 0 ? stripVerseNumber(line) : line)).filter(Boolean),
      ),
    }))
    .filter((section) => section.lines.length > 0);

  if (sections.length === 0) return null;

  const joined = credits.join(" ");
  const copyright = (joined.match(/copyright:\s*(.+)$/i) || [])[1]?.trim() ?? "";

  return {
    title,
    // Kept verbatim rather than parsed into fields. These lines are the
    // evidence for the claim that the hymn may be used, and a reader checking
    // that claim wants what the publisher wrote, not our summary of it.
    author: (joined.match(/Words:\s*([^]*?)(?=\s+(?:Music|Setting|copyright):|$)/i) || [])[1]?.trim() ?? "",
    composer: (joined.match(/Music:\s*([^]*?)(?=\s+(?:Words|Setting|copyright):|$)/i) || [])[1]?.trim() ?? "",
    copyright,
    source: sources.join(" "),
    sections,
  };
}

/** Pulls the scripture references the ThML edition records per hymn. */
function readScripture(xml) {
  const byTitle = new Map();
  for (const block of xml.match(/<div3\b[^]*?<\/div3>/g) ?? []) {
    const title = (block.match(/<h3>([^]*?)<\/h3>/) || [])[1];
    if (!title) continue;
    const refs = [...block.matchAll(/<scripRef[^>]*>([^]*?)<\/scripRef>/g)].map((match) =>
      match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    );
    if (refs.length) byTitle.set(normalise(title), [...new Set(refs)]);
  }
  return byTitle;
}

/** Titles differ between editions only by case, spacing and punctuation. */
const normalise = (title) =>
  title
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function main() {
  mkdirSync(outputDir, { recursive: true });

  process.stdout.write("fetching scores...\n");
  const [abc, xml] = await Promise.all([fetchText(ABC), fetchText(THML)]);
  const scripture = readScripture(xml);

  const tunes = abc.split(/^(?=X:)/m).filter((chunk) => chunk.startsWith("X:"));

  const hymns = [];
  const rejected = [];
  const seen = new Set();

  for (const tune of tunes) {
    const hymn = readTune(tune);
    if (!hymn) continue;

    if (!wordsArePublicDomain(hymn.copyright)) {
      rejected.push(`${hymn.title} — ${hymn.copyright.slice(0, 60)}`);
      continue;
    }

    // The same hymn appears more than once when it has been set to different
    // tunes. The words are what we keep, so the first setting wins and the
    // rest would be duplicates in the operator's list.
    const key = normalise(hymn.title);
    if (seen.has(key)) continue;
    seen.add(key);

    hymns.push({ ...hymn, scripture: scripture.get(key) ?? [] });
  }

  hymns.sort((a, b) => a.title.localeCompare(b.title));

  const body = JSON.stringify(hymns);
  const packed = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
  writeFileSync(resolve(outputDir, "hymns.json.gz"), packed);

  const manifest = {
    source: "The Open Hymnal Project, edition 2014.06 — openhymnal.org",
    file: "hymns.json.gz",
    hymnCount: hymns.length,
    // Lets the app notice a corrected library on upgrade. A count alone would
    // not: fixing a hymn's wording changes no counts.
    checksum: createHash("sha256").update(body).digest("hex").slice(0, 16),
  };
  writeFileSync(resolve(outputDir, "hymns.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const withScripture = hymns.filter((hymn) => hymn.scripture.length).length;
  const lines = hymns.reduce(
    (total, hymn) => total + hymn.sections.reduce((n, section) => n + section.lines.length, 0),
    0,
  );

  console.log(
    `\n${hymns.length} hymns  ${lines} lines  ${(packed.length / 1024).toFixed(0)} KB` +
      `\n${withScripture} carry scripture references` +
      `\n${rejected.length} rejected as not public domain:`,
  );
  for (const entry of rejected) console.log(`  - ${entry}`);
  console.log(`\nmanifest -> ${resolve(outputDir, "hymns.json")}`);
}

// Importable for tests without running the fetch.
if (process.argv[1] && process.argv[1].endsWith("build-hymns.mjs")) {
  await main();
}
