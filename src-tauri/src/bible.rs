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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub number: i64,
    pub name: String,
    pub chapters: i64,
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
