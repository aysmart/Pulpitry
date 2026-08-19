//! The verse library: SQLite storage, full-text search, and reference parsing.
//!
//! The database lives in the app data directory and is built on first launch
//! from the translation files bundled as Tauri resources. Verse text is static,
//! so the FTS5 index is populated by a single rebuild after import rather than
//! by triggers on every row — bulk-inserting 31,102 verses through triggers is
//! substantially slower for no benefit.

use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Emitted once the first-launch import has settled, carrying a [`LibraryStatus`].
pub const EVENT_LIBRARY: &str = "library:status";

/// Lists the translation files shipped as Tauri resources.
const MANIFEST: &str = "resources/translations.json";

/// The Greek and Hebrew, built by scripts/build-interlinear.mjs.
const INTERLINEAR: &str = "resources/interlinear.tsv.gz";

/// Strong's definitions, built by scripts/build-lexicon.mjs.
const LEXICON: &str = "resources/lexicon.tsv.gz";

/// Bumped whenever the schema below changes. The database is a cache derived
/// entirely from bundled resources, so the cheapest correct migration is to
/// discard it and re-import rather than carry ALTER statements forward.
const SCHEMA_VERSION: i64 = 3;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS translations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    year        INTEGER NOT NULL DEFAULT 0,
    ordinal     INTEGER NOT NULL DEFAULT 0,
    checksum    TEXT    NOT NULL DEFAULT '',
    verse_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS verses (
    id          INTEGER PRIMARY KEY,
    translation TEXT    NOT NULL,
    book_number INTEGER NOT NULL,
    book        TEXT    NOT NULL,
    chapter     INTEGER NOT NULL,
    verse       INTEGER NOT NULL,
    text        TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_verses_reference
    ON verses(translation, book_number, chapter, verse);

/*
 * The original languages, keyed by where a word sits rather than by
 * translation.
 *
 * Greek and Hebrew belong to no translation: a church reading the KJV and one
 * reading the Yoruba Bible are looking at the same underlying text. So this
 * joins on book, chapter and verse, and every translation gets it for free.
 *
 * No foreign key to `verses`. A verse a translation happens not to carry -- a
 * versification difference, a book still importing -- should not take its Greek
 * with it.
 */
CREATE TABLE IF NOT EXISTS interlinear (
    book_number     INTEGER NOT NULL,
    chapter         INTEGER NOT NULL,
    verse           INTEGER NOT NULL,
    position        INTEGER NOT NULL,
    original        TEXT    NOT NULL,
    transliteration TEXT    NOT NULL DEFAULT '',
    gloss           TEXT    NOT NULL DEFAULT '',
    strongs         TEXT    NOT NULL DEFAULT '',
    morphology      TEXT    NOT NULL DEFAULT '',
    lemma           TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (book_number, chapter, verse, position)
);

/*
 * What a Strong's number means, from STEPBible's brief lexicons.
 *
 * Keyed by the same extended numbers the interlinear carries, so a word on
 * screen reaches its entry with nothing to match on.
 */
CREATE TABLE IF NOT EXISTS lexicon (
    strongs     TEXT PRIMARY KEY,
    lemma       TEXT NOT NULL DEFAULT '',
    translit    TEXT NOT NULL DEFAULT '',
    part        TEXT NOT NULL DEFAULT '',
    gloss       TEXT NOT NULL DEFAULT '',
    definition  TEXT NOT NULL DEFAULT '',
    -- Thayer's, where there is one. Greek New Testament only.
    thayer      TEXT NOT NULL DEFAULT ''
);

/*
 * Which build of a bundled resource is in the tables above.
 *
 * The interlinear and the lexicon were guarded on row count alone, which
 * answers "has this ever been imported" and not "is this the current text".
 * They are the same count either way, so a correction to the words themselves
 * -- 2,218 Thayer's entries reaching the operator with a literal `&#x27;` in
 * the middle of a sentence -- would have landed on new installations only, and
 * never on anybody who already had the app.
 */
CREATE TABLE IF NOT EXISTS imports (
    name        TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verse_embeddings (
    verse_id    INTEGER PRIMARY KEY,
    translation TEXT NOT NULL,
    vector      BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_translation
    ON verse_embeddings(translation);

CREATE VIRTUAL TABLE IF NOT EXISTS verses_fts USING fts5(
    text,
    content='verses',
    content_rowid='id',
    tokenize='porter unicode61'
);
"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Translation {
    pub id: String,
    pub name: String,
    pub year: i64,
    pub verse_count: i64,
}

/// A stable fingerprint of a bundled resource, so a corrected one reimports.
///
/// FNV-1a over the bytes, with the length mixed in. Hand-rolled in six lines
/// because the only requirement is that the same file gives the same answer on
/// every machine and for ever: `DefaultHasher` is explicitly not stable across
/// Rust releases, and a hash that changes when the toolchain does would rewrite
/// half a million rows on somebody's Sunday morning for no reason. It is not a
/// checksum -- nothing here is defending against a tampered resource, only
/// noticing that the text changed.
fn fingerprint(raw: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in raw.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}-{}", hash, raw.len())
}

/// The fingerprint of the resource that filled a table, if one is recorded.
///
/// Missing on any database built before `imports` existed, which reads as "not
/// current" and costs those installations one reimport.
fn imported_mark(connection: &Connection, name: &str) -> Option<String> {
    connection
        .query_row("SELECT fingerprint FROM imports WHERE name = ?1", params![name], |row| {
            row.get(0)
        })
        .optional()
        .ok()
        .flatten()
}

/// Columns added after a table first shipped.
///
/// `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that already
/// exists, so a new column has to be added by hand — and finding that out cost
/// a release in which every launch logged "table lexicon has no column named
/// thayer" and the lexicon silently stayed empty on every machine that had
/// already run the previous version.
///
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so each is attempted and a
/// complaint that it already exists is the expected outcome on every run after
/// the first. Append only: removing an entry does not remove the column from
/// anybody's database.
fn migrate(connection: &Connection) {
    for statement in ["ALTER TABLE lexicon ADD COLUMN thayer TEXT NOT NULL DEFAULT ''"] {
        // A failure here is almost always "duplicate column name", which is
        // success. Anything else surfaces when the query that needs the column
        // runs, with a message naming the column rather than the migration.
        let _ = connection.execute(statement, []);
    }
}

/// One entry of `resources/translations.json`, written by scripts/build-bible.mjs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    id: String,
    name: String,
    year: i64,
    file: String,
    verse_count: i64,
    checksum: String,
    /*
     * The licence, where the text carries one.
     *
     * Absent on the public-domain translations, which is most of them. Present
     * on the Biblica open editions and the Free Bible Version, which are
     * CC BY-SA -- and for those, naming the source is a condition of being
     * allowed to ship the text at all, not a courtesy. It is read here so the
     * About dialog can list them rather than the obligation living in a comment
     * somebody has to remember.
     */
    #[serde(default)]
    licence: Option<String>,
    #[serde(default)]
    attribution: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub number: i64,
    pub name: String,
    pub chapters: i64,
}

/// One word of the original, as the operator's screen shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalWord {
    /// The Greek or Hebrew itself. Hebrew keeps its `/` morpheme boundaries,
    /// because "in/ beginning" is how the language actually works and
    /// flattening it discards the thing an interlinear exists to show.
    pub original: String,
    pub transliteration: String,
    /// The contextual gloss, brackets included: "[The] book" is more honest
    /// than "book" about what the original says and what English adds.
    pub gloss: String,
    /// Disambiguated Strong's — `G0025`, `H1254A`.
    pub strongs: String,
    pub morphology: String,
    /// The dictionary form, for looking a root up elsewhere.
    pub lemma: String,
}

/// One Strong's entry, as the operator reads it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexiconEntry {
    pub strongs: String,
    pub lemma: String,
    pub transliteration: String,
    /// The lexicon's own part-of-speech code — `G:N-F`, `G:V`.
    pub part: String,
    /// A few words. What a busy operator reads.
    pub gloss: String,
    /// The full entry, paragraphs separated by newlines. Plain text: the
    /// source is HTML and is stripped at build time rather than rendered.
    pub definition: String,
    /// Thayer's, where there is one — Greek New Testament only, so every
    /// Hebrew word and a good many Greek ones have none.
    pub thayer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verse {
    pub id: i64,
    pub translation: String,
    pub book_number: i64,
    pub book: String,
    pub chapter: i64,
    pub verse: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStatus {
    pub ready: bool,
    pub translations: Vec<Translation>,
    /// Name of the translation being imported right now, if any.
    pub importing: Option<String>,
    pub error: Option<String>,
}

pub struct Library {
    connection: Mutex<Connection>,
}

impl Library {
    pub fn open(app: &AppHandle) -> Result<Self> {
        let directory = app
            .path()
            .app_data_dir()
            .context("could not resolve the app data directory")?;
        fs::create_dir_all(&directory).context("could not create the app data directory")?;

        let connection = Connection::open(directory.join("pulpitry.db"))
            .context("could not open the verse library")?;

        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != SCHEMA_VERSION {
            connection.execute_batch(
                "DROP TABLE IF EXISTS verses_fts;
                 DROP TABLE IF EXISTS verses;
                 DROP TABLE IF EXISTS translations;",
            )?;
        }
        connection.execute_batch(SCHEMA).context("could not prepare the verse library")?;
        migrate(&connection);
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;

        Ok(Self { connection: Mutex::new(connection) })
    }

    /// Opens an already-built library read-only, for tests that want to run
    /// against the full imported text rather than a fixture.
    #[cfg(test)]
    pub(crate) fn open_read_only(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    /// An empty in-memory library, for tests that need real SQL and a real
    /// FTS5 index without a packaged app around them.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch(SCHEMA)?;
        migrate(&connection);
        Ok(Self { connection: Mutex::new(connection) })
    }

    /// Seeds verses as `(book_number, book, chapter, verse, text)`.
    #[cfg(test)]
    pub(crate) fn seed(&self, translation: &str, verses: &[(i64, &str, i64, i64, &str)]) -> Result<()> {
        let connection = self.connection.lock();
        for (book_number, book, chapter, verse, text) in verses {
            connection.execute(
                "INSERT INTO verses(translation, book_number, book, chapter, verse, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![translation, book_number, book, chapter, verse, text],
            )?;
        }
        connection.execute("INSERT INTO verses_fts(verses_fts) VALUES('rebuild')", [])?;
        Ok(())
    }

    /// Every verse from the given books, for tests that need a realistic corpus.
    #[cfg(test)]
    pub(crate) fn verses_in_books(&self, translation: &str, books: &[i64]) -> Result<Vec<Verse>> {
        let connection = self.connection.lock();
        let mut found = Vec::new();
        let mut statement = connection.prepare(
            "SELECT id, translation, book_number, book, chapter, verse, text FROM verses
             WHERE translation = ?1 AND book_number = ?2
             ORDER BY chapter, verse",
        )?;
        for book in books {
            let rows = statement.query_map(params![translation, book], read_verse)?;
            for row in rows {
                found.push(row?);
            }
        }
        Ok(found)
    }

    /// Imports every bundled translation that is not already present, calling
    /// `progress` before and after each one. Safe to run on every launch; it is
    /// a no-op once the library is populated.
    ///
    /// Translations land one at a time, in manifest order, so the operator can
    /// start working with the first while the rest are still arriving.
    pub fn ensure_bundled_translations(
        &self,
        app: &AppHandle,
        progress: impl Fn(LibraryStatus),
    ) -> Result<()> {
        for (ordinal, entry) in self.manifest(app)?.into_iter().enumerate() {
            if self.translation_is_current(&entry)? {
                continue;
            }

            let mut status = self.status()?;
            status.importing = Some(entry.name.clone());
            progress(status);

            let path = app
                .path()
                .resolve(
                    &format!("resources/{}", entry.file),
                    tauri::path::BaseDirectory::Resource,
                )
                .with_context(|| format!("could not locate the bundled {} text", entry.id))?;

            self.import(&entry, ordinal as i64, &path)
                .with_context(|| format!("could not import {}", entry.id))?;

            progress(self.status()?);
        }
        Ok(())
    }

    /// The texts whose licence obliges us to name them.
    ///
    /// CC BY-SA permits the commercial use this makes of them and asks for
    /// attribution in return, so this is a condition of shipping rather than a
    /// credit we chose to give. Deduplicated because five of the translations
    /// are Biblica's and one line covers them.
    pub fn attributions(&self, app: &AppHandle) -> Vec<String> {
        let Ok(entries) = self.manifest(app) else {
            return Vec::new();
        };

        let mut seen: Vec<String> = Vec::new();
        for entry in entries {
            let (Some(licence), Some(who)) = (entry.licence, entry.attribution) else {
                continue;
            };
            let line = format!("{who} — {licence}");
            if !seen.contains(&line) {
                seen.push(line);
            }
        }
        seen
    }

    fn manifest(&self, app: &AppHandle) -> Result<Vec<ManifestEntry>> {
        let path = app
            .path()
            .resolve(MANIFEST, tauri::path::BaseDirectory::Resource)
            .context("could not locate the translation manifest")?;
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("could not read {}", path.display()))?;
        serde_json::from_str(&raw).context("the translation manifest is malformed")
    }

    /// Whether the installed copy matches what is bundled.
    ///
    /// Two things have to line up. The checksum catches a corrected text
    /// shipped in an app update, which a verse count alone would miss because
    /// fixing wording changes no counts. The row count catches an import that
    /// was interrupted partway and must not be mistaken for a finished one.
    fn translation_is_current(&self, entry: &ManifestEntry) -> Result<bool> {
        let connection = self.connection.lock();
        let installed: Option<(String, i64)> = connection
            .query_row(
                "SELECT checksum, verse_count FROM translations WHERE id = ?1",
                params![entry.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let Some((checksum, expected)) = installed else { return Ok(false) };
        if checksum != entry.checksum || expected <= 0 {
            return Ok(false);
        }

        let actual: i64 = connection.query_row(
            "SELECT COUNT(*) FROM verses WHERE translation = ?1",
            params![entry.id],
            |row| row.get(0),
        )?;
        Ok(actual == expected)
    }

    fn import(&self, entry: &ManifestEntry, ordinal: i64, path: &Path) -> Result<i64> {
        let id = &entry.id;
        let file = fs::File::open(path)
            .with_context(|| format!("could not open {}", path.display()))?;
        let mut raw = String::new();
        GzDecoder::new(file)
            .read_to_string(&mut raw)
            .with_context(|| format!("could not decompress {}", path.display()))?;

        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM verses WHERE translation = ?1", params![id])?;

        let mut imported = 0i64;
        {
            let mut insert = transaction.prepare(
                "INSERT INTO verses(translation, book_number, book, chapter, verse, text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;

            for (index, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let mut fields = line.splitn(5, '\t');
                let (Some(book_number), Some(book), Some(chapter), Some(verse), Some(text)) = (
                    fields.next(),
                    fields.next(),
                    fields.next(),
                    fields.next(),
                    fields.next(),
                ) else {
                    bail!("{}: line {} has too few fields", path.display(), index + 1);
                };

                insert.execute(params![
                    id,
                    book_number.parse::<i64>().context("bad book number")?,
                    book,
                    chapter.parse::<i64>().context("bad chapter number")?,
                    verse.parse::<i64>().context("bad verse number")?,
                    text,
                ])?;
                imported += 1;
            }
        }

        // The manifest records what this file should contain. A mismatch means
        // the resource is truncated or does not match the manifest it shipped
        // with — importing it part-way would leave a Bible with holes in it.
        if imported != entry.verse_count {
            bail!(
                "{} yielded {imported} verses but the manifest expects {}",
                path.display(),
                entry.verse_count
            );
        }

        transaction.execute(
            "INSERT INTO translations(id, name, year, ordinal, checksum, verse_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 year = excluded.year,
                 ordinal = excluded.ordinal,
                 checksum = excluded.checksum,
                 verse_count = excluded.verse_count",
            params![id, entry.name, entry.year, ordinal, entry.checksum, imported],
        )?;
        transaction.commit()?;

        // External-content FTS5: build the index in one pass from the table.
        connection.execute("INSERT INTO verses_fts(verses_fts) VALUES('rebuild')", [])?;

        Ok(imported)
    }

    pub fn status(&self) -> Result<LibraryStatus> {
        let translations = self.translations()?;
        Ok(LibraryStatus {
            ready: !translations.is_empty(),
            translations,
            importing: None,
            error: None,
        })
    }

    pub fn translations(&self) -> Result<Vec<Translation>> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, name, year, verse_count FROM translations ORDER BY ordinal, name")?;
        let rows = statement.query_map([], |row| {
            Ok(Translation {
                id: row.get(0)?,
                name: row.get(1)?,
                year: row.get(2)?,
                verse_count: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Finds verses containing `words` as a contiguous phrase.
    ///
    /// Used by verse detection: an exact quotation shows up as a run of words
    /// appearing in the same order, which is precisely what an FTS5 phrase
    /// query tests. Returns at most `limit` rows, so the caller can tell a
    /// distinctive quotation from a stock biblical turn of phrase by how many
    /// verses come back.
    pub fn phrase_search(&self, translation: &str, words: &[String], limit: i64) -> Result<Vec<Verse>> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        // Words arrive already normalised to letters, digits and apostrophes,
        // so nothing here can break out of the quoted phrase.
        let phrase = format!("\"{}\"", words.join(" "));

        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT v.id, v.translation, v.book_number, v.book, v.chapter, v.verse, v.text
             FROM verses_fts f
             JOIN verses v ON v.id = f.rowid
             WHERE verses_fts MATCH ?1 AND v.translation = ?2
             LIMIT ?3",
        )?;
        let rows = statement.query_map(params![phrase, translation, limit], read_verse)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Verses still needing an embedding, oldest id first.
    ///
    /// Returned in batches so an interrupted index build resumes where it left
    /// off rather than starting the two-minute job again.
    /// Verses after `after` that have no vector yet, in id order.
    ///
    /// The caller advances `after` past the last id it received, so the scan
    /// never revisits ground it has covered.
    pub fn verses_awaiting_embedding(
        &self,
        translation: &str,
        after: i64,
        limit: i64,
    ) -> Result<Vec<(i64, String)>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            /*
             * Everything past `after` that still has no vector.
             *
             * The obvious form of this -- no cursor, just "the first N without
             * one" -- re-scans from the beginning of the translation on every
             * call. That is invisible for the first batch and ruinous by the
             * thousandth: the work grows with what has already been done, so
             * the build gets slower the closer it is to finishing. Carrying a
             * cursor makes each batch cost the same as the first.
             */
            "SELECT v.id, v.text FROM verses v
             LEFT JOIN verse_embeddings e ON e.verse_id = v.id
             WHERE v.translation = ?1 AND v.id > ?2 AND e.verse_id IS NULL
             ORDER BY v.id
             LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![translation, after, limit], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// How many verses exist, and how many of them are embedded.
    pub fn embedding_progress(&self, translation: &str) -> Result<(i64, i64)> {
        let connection = self.connection.lock();
        let total: i64 = connection.query_row(
            "SELECT COUNT(*) FROM verses WHERE translation = ?1",
            params![translation],
            |row| row.get(0),
        )?;
        let done: i64 = connection.query_row(
            "SELECT COUNT(*) FROM verse_embeddings WHERE translation = ?1",
            params![translation],
            |row| row.get(0),
        )?;
        Ok((done, total))
    }

    pub fn store_embeddings(&self, translation: &str, rows: &[(i64, Vec<u8>)]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        {
            let mut insert = transaction.prepare(
                "INSERT INTO verse_embeddings(verse_id, translation, vector)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(verse_id) DO UPDATE SET vector = excluded.vector",
            )?;
            for (verse_id, vector) in rows {
                insert.execute(params![verse_id, translation, vector])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Drops a translation's embeddings so they can be recomputed.
    pub fn clear_embeddings(&self, translation: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "DELETE FROM verse_embeddings WHERE translation = ?1",
            params![translation],
        )?;
        Ok(())
    }

    /// Reads the whole index for a translation into memory for searching.
    pub fn load_embeddings(&self, translation: &str) -> Result<Vec<(i64, Vec<u8>)>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT verse_id, vector FROM verse_embeddings WHERE translation = ?1 ORDER BY verse_id",
        )?;
        let rows = statement
            .query_map(params![translation], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Fetches verses by id, in the order given.
    pub fn verses_by_id(&self, ids: &[i64]) -> Result<Vec<Verse>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, translation, book_number, book, chapter, verse, text FROM verses
             WHERE id = ?1",
        )?;
        let mut found = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(verse) = statement.query_row(params![id], read_verse).optional()? {
                found.push(verse);
            }
        }
        Ok(found)
    }

    pub fn books(&self, translation: &str) -> Result<Vec<Book>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT book_number, book, MAX(chapter) FROM verses
             WHERE translation = ?1
             GROUP BY book_number, book
             ORDER BY book_number",
        )?;
        let rows = statement.query_map(params![translation], |row| {
            Ok(Book { number: row.get(0)?, name: row.get(1)?, chapters: row.get(2)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The Greek or Hebrew behind one verse, in the order it is read.
    ///
    /// Empty rather than an error when there is none. The Apocrypha, a
    /// versification difference, a verse number a translation carries and the
    /// original does not -- none of those is a fault, and an operator who
    /// opened the panel on one should see nothing rather than a complaint.
    pub fn original(&self, book_number: i64, chapter: i64, verse: i64) -> Result<Vec<OriginalWord>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT original, transliteration, gloss, strongs, morphology, lemma
             FROM interlinear
             WHERE book_number = ?1 AND chapter = ?2 AND verse = ?3
             ORDER BY position",
        )?;

        let words = statement
            .query_map(params![book_number, chapter, verse], |row| {
                Ok(OriginalWord {
                    original: row.get(0)?,
                    transliteration: row.get(1)?,
                    gloss: row.get(2)?,
                    strongs: row.get(3)?,
                    morphology: row.get(4)?,
                    lemma: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(words)
    }

    /// Loads the interlinear once, and never again unless the file changes.
    ///
    /// Four hundred thousand rows is a few seconds of inserts, so it is guarded
    /// by a count rather than repeated on every launch. A partial import from an
    /// interrupted first run is caught by that same count being wrong, and the
    /// table is rebuilt from scratch rather than topped up -- half an
    /// interlinear is worse than none, because nothing about it looks broken.
    pub fn ensure_interlinear(&self, app: &AppHandle) -> Result<i64> {
        let path = app
            .path()
            .resolve(INTERLINEAR, tauri::path::BaseDirectory::Resource)
            .context("the interlinear resource is missing from this build")?;

        let file = fs::File::open(&path)
            .with_context(|| format!("could not open {}", path.display()))?;
        let mut raw = String::new();
        GzDecoder::new(file)
            .read_to_string(&mut raw)
            .with_context(|| format!("could not decompress {}", path.display()))?;

        let expected = raw.lines().filter(|line| !line.trim().is_empty()).count() as i64;
        let mark = fingerprint(&raw);

        {
            let connection = self.connection.lock();
            let held: i64 =
                connection.query_row("SELECT COUNT(*) FROM interlinear", [], |row| row.get(0))?;
            if held == expected && imported_mark(&connection, "interlinear").as_deref() == Some(&mark) {
                return Ok(0);
            }
        }

        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM interlinear", [])?;

        let mut imported = 0i64;
        {
            let mut insert = transaction.prepare(
                "INSERT INTO interlinear(book_number, chapter, verse, position,
                                         original, transliteration, gloss, strongs,
                                         morphology, lemma)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?;

            for (index, line) in raw.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() < 10 {
                    bail!("{}: line {} has too few fields", path.display(), index + 1);
                }
                insert.execute(params![
                    fields[0].parse::<i64>().context("bad book number")?,
                    fields[1].parse::<i64>().context("bad chapter number")?,
                    fields[2].parse::<i64>().context("bad verse number")?,
                    fields[3].parse::<i64>().context("bad word position")?,
                    fields[4],
                    fields[5],
                    fields[6],
                    fields[7],
                    fields[8],
                    fields[9],
                ])?;
                imported += 1;
            }
        }
        // Recorded inside the transaction: a mark without the rows it
        // describes would tell the next launch there is nothing to do.
        transaction.execute(
            "INSERT INTO imports(name, fingerprint) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET fingerprint = excluded.fingerprint",
            params!["interlinear", mark],
        )?;
        transaction.commit()?;

        crate::log_line!("[bible] imported {imported} words of Greek and Hebrew");
        Ok(imported)
    }

    /// What one Strong's number means, looked up progressively.
    ///
    /// # Why one lookup is three
    ///
    /// The interlinear and the lexicon disagree about how a Strong's number is
    /// written, and finding that out cost 10,844 words — over half the Hebrew —
    /// silently having no entry at all.
    ///
    /// The interlinear carries the *disambiguated* number: `H1254A` where two
    /// distinct roots share one Strong's number, `H7225G` where the sense is
    /// pinned by the Greek, `H0853_A` for a further split. The lexicon is keyed
    /// more coarsely, and where it does disambiguate it lowercases the suffix:
    /// `H1254a`.
    ///
    /// So: exact, then case-insensitively, then with the disambiguators
    /// stripped. The last is a slightly wider answer than was asked for — the
    /// root rather than one sense of it — which for an operator reading a word
    /// in a service is far better than nothing, and is what a printed
    /// concordance would have given them anyway.
    pub fn lexicon(&self, strongs: &str) -> Result<Option<LexiconEntry>> {
        let trimmed = strongs.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        // `H0853_A` -> `H0853`, `H7225G` -> `H7225`. The number is the prefix
        // letter and the digits; anything after it is disambiguation.
        let base: String = {
            let mut out = String::new();
            let mut chars = trimmed.chars();
            if let Some(letter) = chars.next() {
                out.push(letter);
            }
            for ch in chars {
                if ch.is_ascii_digit() {
                    out.push(ch);
                } else {
                    break;
                }
            }
            out
        };

        for (sql, key) in [
            ("SELECT strongs, lemma, translit, part, gloss, definition, thayer FROM lexicon WHERE strongs = ?1", trimmed.to_string()),
            ("SELECT strongs, lemma, translit, part, gloss, definition, thayer FROM lexicon WHERE strongs = ?1 COLLATE NOCASE", trimmed.to_string()),
            ("SELECT strongs, lemma, translit, part, gloss, definition, thayer FROM lexicon WHERE strongs = ?1 COLLATE NOCASE", base.clone()),
            /*
             * Last: the first entry sharing this number, whatever its suffix.
             *
             * `H5921A_A` is a sense of a sense, and the lexicon carries neither
             * it nor a bare `H5921` -- only `H5921a`. Without this step every
             * word like it, and there are thousands, has no entry at all while
             * the definition sits in the table under a name one character off.
             *
             * Ordered so the answer is stable rather than whichever row the
             * planner reached first: the same word gives the same entry twice.
             */
            ("SELECT strongs, lemma, translit, part, gloss, definition, thayer FROM lexicon WHERE strongs LIKE ?1 || '%' ORDER BY strongs LIMIT 1", base.clone()),
        ] {
            if key.is_empty() {
                continue;
            }
            if let Some(found) = self.lexicon_row(sql, &key)? {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }

    fn lexicon_row(&self, sql: &str, key: &str) -> Result<Option<LexiconEntry>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(sql)?;

        let mut rows = statement.query_map(params![key], |row| {
            Ok(LexiconEntry {
                strongs: row.get(0)?,
                lemma: row.get(1)?,
                transliteration: row.get(2)?,
                part: row.get(3)?,
                gloss: row.get(4)?,
                definition: row.get(5)?,
                thayer: row.get(6)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// Loads the lexicon once, guarded by a row count like the interlinear.
    pub fn ensure_lexicon(&self, app: &AppHandle) -> Result<i64> {
        let path = app
            .path()
            .resolve(LEXICON, tauri::path::BaseDirectory::Resource)
            .context("the lexicon resource is missing from this build")?;

        let file = fs::File::open(&path)
            .with_context(|| format!("could not open {}", path.display()))?;
        let mut raw = String::new();
        GzDecoder::new(file)
            .read_to_string(&mut raw)
            .with_context(|| format!("could not decompress {}", path.display()))?;

        let expected = raw.lines().filter(|line| !line.trim().is_empty()).count() as i64;
        let mark = fingerprint(&raw);
        {
            let connection = self.connection.lock();
            let held: i64 =
                connection.query_row("SELECT COUNT(*) FROM lexicon", [], |row| row.get(0))?;
            if held == expected && imported_mark(&connection, "lexicon").as_deref() == Some(&mark) {
                return Ok(0);
            }
        }

        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM lexicon", [])?;

        let mut imported = 0i64;
        {
            let mut insert = transaction.prepare(
                "INSERT INTO lexicon(strongs, lemma, translit, part, gloss, definition, thayer)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for line in raw.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() < 6 {
                    continue;
                }
                insert.execute(params![
                    fields[0],
                    fields[1],
                    fields[2],
                    fields[3],
                    fields[4],
                    // Paragraphs are marked rather than embedded, so a row
                    // stays a row. Put back on the way in.
                    fields[5].replace('¶', "\n"),
                    fields.get(6).unwrap_or(&"").replace('¶', "\n"),
                ])?;
                imported += 1;
            }
        }
        // Recorded inside the transaction: a mark without the rows it
        // describes would tell the next launch there is nothing to do.
        transaction.execute(
            "INSERT INTO imports(name, fingerprint) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET fingerprint = excluded.fingerprint",
            params!["lexicon", mark],
        )?;
        transaction.commit()?;

        crate::log_line!("[bible] imported {imported} lexicon entries");
        Ok(imported)
    }

    pub fn chapter(&self, translation: &str, book_number: i64, chapter: i64) -> Result<Vec<Verse>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, translation, book_number, book, chapter, verse, text FROM verses
             WHERE translation = ?1 AND book_number = ?2 AND chapter = ?3
             ORDER BY verse",
        )?;
        let rows = statement
            .query_map(params![translation, book_number, chapter], read_verse)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Full-text search across a translation, best matches first.
    pub fn search(&self, translation: &str, query: &str, limit: i64) -> Result<Vec<Verse>> {
        let Some(match_expression) = fts_query(query) else { return Ok(Vec::new()) };

        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT v.id, v.translation, v.book_number, v.book, v.chapter, v.verse, v.text
             FROM verses_fts f
             JOIN verses v ON v.id = f.rowid
             WHERE verses_fts MATCH ?1 AND v.translation = ?2
             ORDER BY bm25(verses_fts)
             LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![match_expression, translation, limit.clamp(1, 500)], read_verse)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Looks up one verse by its exact coordinates.
    ///
    /// This is the verification step for model-proposed references: the model
    /// supplies a reference and nothing more, and the text the operator sees
    /// comes from here. A reference that does not resolve is discarded, so a
    /// fabricated one cannot reach the screen.
    pub fn verse_at(
        &self,
        translation: &str,
        book_number: i64,
        chapter: i64,
        verse: i64,
    ) -> Result<Option<Verse>> {
        let connection = self.connection.lock();
        Ok(connection
            .query_row(
                "SELECT id, translation, book_number, book, chapter, verse, text FROM verses
                 WHERE translation = ?1 AND book_number = ?2 AND chapter = ?3 AND verse = ?4",
                params![translation, book_number, chapter, verse],
                read_verse,
            )
            .optional()?)
    }

    /// Resolves a spoken reading to a real location, or nothing.
    ///
    /// This is what settles "psalm one nineteen": Psalm 1 has no verse 19, and
    /// Psalm 119 does, so the library decides rather than a guess.
    pub fn locate(
        &self,
        translation: &str,
        book: &str,
        chapter: i64,
        verse: Option<i64>,
    ) -> Result<Option<Reference>> {
        let connection = self.connection.lock();
        let found: Option<(i64, i64)> = connection
            .query_row(
                "SELECT book_number, MAX(verse) FROM verses
                 WHERE translation = ?1 AND book = ?2 AND chapter = ?3",
                params![translation, book, chapter],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let Some((book_number, last_verse)) = found else { return Ok(None) };
        if verse.is_some_and(|verse| verse < 1 || verse > last_verse) {
            return Ok(None);
        }

        Ok(Some(Reference {
            book_number,
            book: book.to_string(),
            chapter,
            verse,
            end_verse: None,
        }))
    }

    /// The verse immediately before or after this one in canonical order,
    /// crossing chapter and book boundaries — a reading rarely stops neatly at
    /// the end of a chapter.
    pub fn adjacent_verse(
        &self,
        translation: &str,
        book_number: i64,
        chapter: i64,
        verse: i64,
        forward: bool,
    ) -> Result<Option<Verse>> {
        let sql = if forward {
            "SELECT id, translation, book_number, book, chapter, verse, text FROM verses
             WHERE translation = ?1 AND (book_number, chapter, verse) > (?2, ?3, ?4)
             ORDER BY book_number, chapter, verse LIMIT 1"
        } else {
            "SELECT id, translation, book_number, book, chapter, verse, text FROM verses
             WHERE translation = ?1 AND (book_number, chapter, verse) < (?2, ?3, ?4)
             ORDER BY book_number DESC, chapter DESC, verse DESC LIMIT 1"
        };

        let connection = self.connection.lock();
        Ok(connection
            .query_row(sql, params![translation, book_number, chapter, verse], read_verse)
            .optional()?)
    }

    /// Resolves free text like "Luke 3", "John 3:16" or "1 cor 13" to a
    /// location, using the book names actually present in this translation.
    pub fn resolve_reference(&self, translation: &str, input: &str) -> Result<Option<Reference>> {
        let books = self.books(translation)?;
        let names: Vec<&str> = books.iter().map(|book| book.name.as_str()).collect();
        let Some(parsed) = parse_reference(input, &names) else { return Ok(None) };

        let book = books
            .iter()
            .find(|book| book.name == parsed.book)
            .ok_or_else(|| anyhow!("resolved a book that is not in the translation"))?;

        // Clamp rather than reject: "Psalms 200" should land on the last
        // chapter instead of doing nothing.
        let chapter = parsed.chapter.clamp(1, book.chapters);
        Ok(Some(Reference {
            book_number: book.number,
            book: book.name.clone(),
            chapter,
            verse: parsed.verse,
            end_verse: parsed.end_verse,
        }))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub book_number: i64,
    pub book: String,
    pub chapter: i64,
    pub verse: Option<i64>,
    /// Set when the operator typed a range: "John 3:16-18" ends at 18.
    pub end_verse: Option<i64>,
}

fn read_verse(row: &rusqlite::Row<'_>) -> rusqlite::Result<Verse> {
    Ok(Verse {
        id: row.get(0)?,
        translation: row.get(1)?,
        book_number: row.get(2)?,
        book: row.get(3)?,
        chapter: row.get(4)?,
        verse: row.get(5)?,
        text: row.get(6)?,
    })
}

/// Turns operator input into an FTS5 MATCH expression.
///
/// Every token is quoted, which both escapes FTS5's operators (`AND`, `*`, `:`,
/// `-` would otherwise be parsed as syntax, and unbalanced quotes are an error)
/// and gives us an implicit AND across the terms.
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect();

    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedReference {
    book: String,
    chapter: i64,
    verse: Option<i64>,
    end_verse: Option<i64>,
}

/// Abbreviations that prefix matching cannot reach, or where it would be
/// ambiguous ("phil" matches both Philippians and Philemon; convention says
/// Philippians).
const ALIASES: &[(&str, &str)] = &[
    ("ps", "psalms"),
    ("psa", "psalms"),
    ("psalm", "psalms"),
    ("pss", "psalms"),
    ("mt", "matthew"),
    ("mk", "mark"),
    ("lk", "luke"),
    ("jn", "john"),
    ("jhn", "john"),
    ("phil", "philippians"),
    ("php", "philippians"),
    ("phm", "philemon"),
    ("jas", "james"),
    ("jm", "james"),
    ("rev", "revelation"),
    ("rom", "romans"),
    ("sos", "songofsolomon"),
    ("song", "songofsolomon"),
    ("songofsongs", "songofsolomon"),
    ("ecc", "ecclesiastes"),
    ("prov", "proverbs"),
    ("deut", "deuteronomy"),
    ("josh", "joshua"),
    ("judg", "judges"),
    ("neh", "nehemiah"),
    ("est", "esther"),
    ("isa", "isaiah"),
    ("jer", "jeremiah"),
    ("lam", "lamentations"),
    ("ezek", "ezekiel"),
    ("dan", "daniel"),
    ("hos", "hosea"),
    ("obad", "obadiah"),
    ("mic", "micah"),
    ("nah", "nahum"),
    ("hab", "habakkuk"),
    ("zeph", "zephaniah"),
    ("hag", "haggai"),
    ("zech", "zechariah"),
    ("mal", "malachi"),
    ("gal", "galatians"),
    ("eph", "ephesians"),
    ("col", "colossians"),
    ("heb", "hebrews"),
    ("acts", "acts"),
];

fn normalize(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Splits "1 John 3:16" into its book and its numbers, then resolves the book
/// against `books`.
fn parse_reference(input: &str, books: &[&str]) -> Option<ParsedReference> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    // The book ends at the first digit that follows a letter; a leading digit
    // belongs to the name ("1 John", "2 Corinthians").
    let characters: Vec<char> = trimmed.chars().collect();
    let mut split = characters.len();
    let mut seen_letter = false;
    for (index, character) in characters.iter().enumerate() {
        if character.is_alphabetic() {
            seen_letter = true;
        } else if character.is_ascii_digit() && seen_letter {
            split = index;
            break;
        }
    }

    let name: String = characters[..split].iter().collect();
    let numbers: String = characters[split..].iter().collect();
    let book = resolve_book(&name, books)?;

    // A bare book name means chapter 1.
    if numbers.trim().is_empty() {
        return Some(ParsedReference { book, chapter: 1, verse: None, end_verse: None });
    }

    let mut parts = numbers.split(|c| c == ':' || c == '.' || c == 'v');
    let chapter = leading_number(parts.next()?)?;

    // The verse part may be a range: "16-18", or with an en dash if it was
    // pasted from somewhere that prettified it.
    let verse_part = parts.next().unwrap_or_default();
    let mut ends = verse_part.split(['-', '\u{2013}', '\u{2014}']);
    let verse = ends.next().and_then(leading_number).filter(|value| *value > 0);
    let end_verse = ends
        .next()
        .and_then(leading_number)
        .filter(|end| verse.is_some_and(|start| *end > start));

    if chapter < 1 {
        return None;
    }
    Some(ParsedReference { book, chapter, verse, end_verse })
}

fn leading_number(text: &str) -> Option<i64> {
    let digits: String = text.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn resolve_book(name: &str, books: &[&str]) -> Option<String> {
    let needle = normalize(name);
    if needle.is_empty() {
        return None;
    }

    if let Some(exact) = books.iter().find(|book| normalize(book) == needle) {
        return Some((*exact).to_string());
    }

    if let Some((_, canonical)) = ALIASES.iter().find(|(alias, _)| *alias == needle) {
        if let Some(book) = books.iter().find(|book| normalize(book) == *canonical) {
            return Some((*book).to_string());
        }
    }

    // Prefix matching, but only when it identifies exactly one book — "jo"
    // could be Job, Joel, John, Jonah or Joshua, and guessing would be worse
    // than handing the text to full-text search.
    let mut candidates = books.iter().filter(|book| normalize(book).starts_with(&needle));
    let first = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    Some((*first).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOKS: &[&str] = &[
        "Genesis", "Exodus", "Joshua", "Job", "Psalms", "Proverbs", "Song of Solomon",
        "Isaiah", "Joel", "Jonah", "Matthew", "Mark", "Luke", "John", "Acts", "Romans",
        "1 Corinthians", "2 Corinthians", "Philippians", "Philemon", "James",
        "1 John", "2 John", "3 John", "Revelation",
    ];

    fn parse(input: &str) -> Option<ParsedReference> {
        parse_reference(input, BOOKS)
    }

    #[test]
    fn parses_book_and_chapter() {
        assert_eq!(
            parse("Luke 3"),
            Some(ParsedReference { book: "Luke".into(), chapter: 3, verse: None, end_verse: None })
        );
    }

    #[test]
    fn parses_chapter_and_verse() {
        assert_eq!(
            parse("John 3:16"),
            Some(ParsedReference { book: "John".into(), chapter: 3, verse: Some(16), end_verse: None })
        );
    }

    #[test]
    fn keeps_the_ordinal_with_the_book_name() {
        assert_eq!(
            parse("1 Corinthians 13:4"),
            Some(ParsedReference { book: "1 Corinthians".into(), chapter: 13, verse: Some(4), end_verse: None })
        );
        assert_eq!(
            parse("3 John 1"),
            Some(ParsedReference { book: "3 John".into(), chapter: 1, verse: None, end_verse: None })
        );
    }

    #[test]
    fn tolerates_missing_spaces_and_odd_separators() {
        assert_eq!(parse("John3:16").unwrap().book, "John");
        assert_eq!(parse("john 3.16").unwrap().verse, Some(16));
        assert_eq!(parse("  luke   3  ").unwrap().chapter, 3);
    }

    #[test]
    fn parses_a_verse_range() {
        let parsed = parse("John 3:16-18").expect("should parse");
        assert_eq!(parsed.verse, Some(16));
        assert_eq!(parsed.end_verse, Some(18));
    }

    #[test]
    fn parses_a_range_written_with_an_en_dash() {
        assert_eq!(parse("John 3:16\u{2013}18").expect("should parse").end_verse, Some(18));
    }

    #[test]
    fn a_backwards_range_is_ignored_rather_than_inverted() {
        // "16-14" is a typo, not a request to read backwards.
        assert_eq!(parse("John 3:16-14").expect("should parse").end_verse, None);
    }

    #[test]
    fn a_single_verse_has_no_range_end() {
        assert_eq!(parse("John 3:16").expect("should parse").end_verse, None);
    }

    #[test]
    fn resolves_abbreviations() {
        assert_eq!(parse("Ps 23").unwrap().book, "Psalms");
        assert_eq!(parse("mt 5:9").unwrap().book, "Matthew");
        assert_eq!(parse("1 cor 13").unwrap().book, "1 Corinthians");
        // Convention, not prefix order.
        assert_eq!(parse("phil 4").unwrap().book, "Philippians");
    }

    #[test]
    fn resolves_unambiguous_prefixes() {
        assert_eq!(parse("gen 1").unwrap().book, "Genesis");
        assert_eq!(parse("prov 3").unwrap().book, "Proverbs");
    }

    #[test]
    fn refuses_ambiguous_prefixes() {
        // Job, Joel, John, Jonah and Joshua all start "jo".
        assert_eq!(parse("jo 1"), None);
    }

    #[test]
    fn a_bare_book_name_opens_chapter_one() {
        assert_eq!(
            parse("Jude"),
            None,
            "Jude is not in the test book list, so it must not resolve"
        );
        assert_eq!(parse("Romans").unwrap().chapter, 1);
    }

    #[test]
    fn rejects_nonsense() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("   "), None);
        assert_eq!(parse("42"), None);
        assert_eq!(parse("Zzyzx 3"), None);
    }

    #[test]
    fn fts_query_quotes_every_term() {
        assert_eq!(fts_query("good shepherd").as_deref(), Some("\"good\" \"shepherd\""));
    }

    #[test]
    fn fts_query_neutralises_operators() {
        // Bare, these would be FTS5 syntax rather than search terms.
        assert_eq!(fts_query("AND OR NOT").as_deref(), Some("\"AND\" \"OR\" \"NOT\""));
        assert_eq!(fts_query("love*").as_deref(), Some("\"love\""));
        assert_eq!(fts_query("a\"b").as_deref(), Some("\"a\" \"b\""));
        assert_eq!(fts_query("   "), None);
        assert_eq!(fts_query("!!!"), None);
    }

    #[test]
    fn fts_query_keeps_apostrophes() {
        assert_eq!(fts_query("god's").as_deref(), Some("\"god's\""));
    }
}
