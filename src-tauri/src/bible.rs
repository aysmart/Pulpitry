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
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Emitted once the first-launch import has settled, carrying a [`LibraryStatus`].
pub const EVENT_LIBRARY: &str = "library:status";

/// Lists the translation files shipped as Tauri resources.
const MANIFEST: &str = "resources/translations.json";

/// The Greek and Hebrew, built by scripts/build-interlinear.mjs.
const INTERLINEAR: &str = "resources/interlinear.tsv.gz";

/// Strong's definitions, built by scripts/build-lexicon.mjs.
const LEXICON: &str = "resources/lexicon.tsv.gz";


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
/*
 * A translation is described in one place, and that place is the shared crate.
 *
 * `resources/translations.json` and the published catalogue are the same
 * document with the same field names; the only difference is that a download
 * needs a size and a real hash, and a file that arrived inside a signed
 * application needs neither. Describing that shape twice would mean a
 * downloaded translation and a bundled one taking different routes into the
 * same table, which is the duplication that has already cost us a table that
 * would not draw and a Fill switch that did nothing in three separate places.
 *
 * So `import` below takes a `Pack` and does not care where the file came from.
 *
 * The licence fields matter more than their size suggests. CC BY-SA obliges us
 * to name Biblica and the Free Bible Version, and that is a condition of being
 * allowed to ship the text at all rather than a credit we chose to give.
 * `attributions` reads them so the obligation lives in a screen instead of in a
 * comment somebody has to remember.
 */
use castavox_core::library;
use castavox_core::packs::Pack;

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

        library::prepare(&connection)?;
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
        library::prepare(&connection)?;
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
        let declined = self.declined()?;
        for (ordinal, entry) in self.manifest(app)?.into_iter().enumerate() {
            // Before the skip, not after. A translation that is already current
            // is exactly the one that will never be reimported, and so exactly
            // the one whose licence would never be recorded.
            library::backfill_licence(&self.connection.lock(), &entry)?;

            // Described but not carried. The manifest lists every translation
            // we publish so it can also serve as the licence register; only
            // some of them have a file here to import.
            if !entry.bundled {
                continue;
            }

            // Removed on purpose. Reimporting it here is how a Remove button
            // becomes a button that works until Sunday.
            if declined.contains(&entry.id) || self.translation_is_current(&entry)? {
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
    /// Read from what is installed rather than from what is bundled, so it
    /// stays right for a translation a church downloaded. See
    /// `castavox_core::library`.
    pub fn attributions(&self, _app: &AppHandle) -> Vec<String> {
        library::attributions(&self.connection.lock()).unwrap_or_default()
    }

    /// The ids this church has removed and does not want back.
    fn declined(&self) -> Result<Vec<String>> {
        library::declined(&self.connection.lock())
    }

    fn manifest(&self, app: &AppHandle) -> Result<Vec<Pack>> {
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
    fn translation_is_current(&self, entry: &Pack) -> Result<bool> {
        library::is_current(&self.connection.lock(), entry)
    }

    fn import(&self, entry: &Pack, ordinal: i64, path: &Path) -> Result<i64> {
        library::import(&mut self.connection.lock(), entry, ordinal, path)
    }

    /// Installs a downloaded pack, by exactly the route a bundled one takes.
    ///
    /// The file has already been fetched and its SHA-256 checked by
    /// `castavox_core::packs`; what happens here is the same transaction
    /// `ensure_bundled_translations` runs, which is the point of the two
    /// sharing a type. A download that arrives corrupt never reaches this
    /// function, and an import that fails inside it rolls back, so there is no
    /// state in between where a church has half a Bible.
    ///
    /// The ordinal puts it after everything already installed. Bundled
    /// translations keep manifest order and downloaded ones arrive in the order
    /// the church asked for them, which is a more useful list than alphabetical:
    /// what you chose is near where you last looked.
    pub fn install(&self, pack: &Pack, path: &Path) -> Result<i64> {
        library::install(&mut self.connection.lock(), pack, path)
    }

    /// Removes an installed translation and everything derived from it.
    ///
    /// Three tables, because a translation is not only its verses: the meaning
    /// index is 65 MB of the reason somebody is removing it in the first place,
    /// and leaving those rows behind would mean the disk barely moves and the
    /// operator concludes the button does nothing.
    ///
    /// It refuses to remove the last one. An application whose entire purpose
    /// is putting scripture on a screen should not offer a control that leaves
    /// it with no scripture, and "you cannot remove your only translation" is a
    /// better answer than a working button and an empty Bible.
    pub fn remove(&self, id: &str) -> Result<()> {
        library::remove(&mut self.connection.lock(), id)
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
        // Alphabetically, everywhere. `ordinal` records the order translations
        // arrived -- the manifest's order for bundled ones, then whatever a
        // church downloaded and when -- which is a fact about how the library
        // was filled and not about how anybody looks through it. A dropdown of
        // thirty-two is scanned, and scanning wants one order it can predict.
        let mut statement = connection
            .prepare("SELECT id, name, year, verse_count FROM translations ORDER BY id")?;
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
    /// The Greek or Hebrew behind one verse, addressed by book name.
    ///
    /// By name and not by number, because the number belongs to whichever
    /// translation is on screen and the interlinear belongs to none of them. A
    /// Catholic Bible numbers John fiftieth; looking that up here would return
    /// Philippians' Greek as the original of what the operator is reading.
    ///
    /// A book the interlinear does not have -- every deuterocanonical one --
    /// returns nothing rather than somebody else's words.
    pub fn original(&self, book: &str, chapter: i64, verse: i64) -> Result<Vec<OriginalWord>> {
        let Some(book_number) = castavox_core::canon::interlinear_book(book) else {
            return Ok(Vec::new());
        };
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
    use std::path::PathBuf;

    /// A pack on disk, as a download would have left one.
    fn pack_file(directory: &Path, id: &str, verses: &[(i64, &str, i64, i64, &str)]) -> PathBuf {
        use std::io::Write;
        let path = directory.join(format!("{id}.tsv.gz"));
        let mut encoder =
            flate2::write::GzEncoder::new(fs::File::create(&path).unwrap(), flate2::Compression::fast());
        for (number, book, chapter, verse, text) in verses {
            writeln!(encoder, "{number}\t{book}\t{chapter}\t{verse}\t{text}").unwrap();
        }
        encoder.finish().unwrap();
        path
    }

    fn pack(id: &str, verse_count: i64) -> Pack {
        Pack {
            id: id.into(),
            name: format!("{id} Version"),
            year: 1611,
            file: format!("{id}.tsv.gz"),
            verse_count,
            checksum: format!("{id}-checksum"),
            sha256: String::new(),
            bytes: 0,
            language: "English".into(),
            bundled: true,
            note: None,
            missing_verses: 0,
            licence: None,
            attribution: None,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bible-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A downloaded pack goes in by the route a bundled one takes, and the
    /// verses are readable afterwards. This is the whole claim the library
    /// screen makes when it says "Installed".
    #[test]
    fn installs_a_downloaded_pack() {
        let dir = scratch("install");
        let library = Library::in_memory().unwrap();
        let file = pack_file(&dir, "AAA", &[(43, "John", 3, 16, "For God so loved the world")]);

        assert_eq!(library.install(&pack("AAA", 1), &file).unwrap(), 1);

        let installed = library.translations().unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].id, "AAA");
        assert_eq!(installed[0].verse_count, 1);

        // Through the FTS index, because an import that fills `verses` and
        // leaves the index empty is one where every search comes back empty
        // and nothing says why.
        let found = library
            .phrase_search("AAA", &["loved".into(), "the".into(), "world".into()], 5)
            .unwrap();
        assert_eq!(found.len(), 1);
    }

    /**
     * The whole chain, against a real pack over a real socket.
     *
     * Ignored, because it needs the catalogue served somewhere. Run it against
     * the published one, or locally:
     *
     * ```text
     * (cd Castavox/build/translations && python3 -m http.server 8787)
     * CATALOGUE=http://127.0.0.1:8787/catalogue.json cargo test --lib -- --ignored
     * ```
     *
     * The unit tests above use fabricated three-verse packs, which is right for
     * what they check and says nothing about a 1.3 MB gzip arriving over a
     * network and hashing to what the catalogue promised. This says that.
     */
    #[test]
    #[ignore = "needs the catalogue served"]
    fn downloads_and_installs_a_real_pack() {
        let url = std::env::var("CATALOGUE")
            .unwrap_or_else(|_| "http://127.0.0.1:8787/catalogue.json".into());
        let base = url.rsplit_once('/').unwrap().0.to_string();

        // Which pack, so the same test can check a downloaded translation and
        // not only the one that also ships in the bundle: PACK=NIV, PACK=TPT.
        let want = std::env::var("PACK").unwrap_or_else(|_| "KJV".into());

        let catalogue = castavox_core::packs::catalogue(&url).unwrap();
        let pack = catalogue
            .iter()
            .find(|p| p.id == want)
            .unwrap_or_else(|| panic!("{want} is not in the catalogue"));

        let dir = scratch("real");
        let file = castavox_core::packs::download(pack, &base, &dir, |_| {}).unwrap();

        let library = Library::in_memory().unwrap();
        assert_eq!(library.install(pack, &file).unwrap(), pack.verse_count);

        // Searched rather than counted, because a row count proves the import
        // ran and nothing about whether the index it built can find anything.
        // John 3:16 is in every translation we publish, including the one whose
        // Old Testament is four books.
        let john = library.chapter(&want, 43, 3).unwrap();
        let verse = john
            .iter()
            .find(|v| v.verse == 16)
            .unwrap_or_else(|| panic!("{want}: John 3:16 is not there"));
        assert!(verse.text.len() > 20, "{want}: {:?}", verse.text);
    }

    /// A truncated pack imports nothing rather than a Bible with holes in it.
    #[test]
    fn refuses_a_pack_that_does_not_match_its_count() {
        let dir = scratch("short");
        let library = Library::in_memory().unwrap();
        let file = pack_file(&dir, "BBB", &[(1, "Genesis", 1, 1, "In the beginning")]);

        assert!(library.install(&pack("BBB", 31102), &file).is_err());
        assert!(library.translations().unwrap().is_empty());
    }

    /// Removing takes the verses and the search index with it, and leaves the
    /// other translations alone.
    #[test]
    fn removes_a_translation_and_only_that_one() {
        let dir = scratch("remove");
        let library = Library::in_memory().unwrap();
        let first = pack_file(&dir, "AAA", &[(43, "John", 3, 16, "For God so loved the world")]);
        let second = pack_file(&dir, "BBB", &[(43, "John", 3, 16, "God loved the world so much")]);
        library.install(&pack("AAA", 1), &first).unwrap();
        library.install(&pack("BBB", 1), &second).unwrap();

        library.remove("AAA").unwrap();

        let left = library.translations().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, "BBB");
        assert!(library
            .phrase_search("AAA", &["loved".into(), "the".into(), "world".into()], 5)
            .unwrap()
            .is_empty());
        assert_eq!(
            library
                .phrase_search("BBB", &["loved".into(), "the".into(), "world".into()], 5)
                .unwrap()
                .len(),
            1
        );
    }

    /// The list reads alphabetically whatever order things arrived in.
    ///
    /// Downloaded translations are given an ordinal after everything already
    /// installed, so ordering by it would put a church's own choices at the
    /// bottom in the order they happened to be fetched. Thirty-two entries in
    /// arrival order is a list you read; alphabetically it is one you scan.
    #[test]
    fn translations_are_listed_alphabetically() {
        let dir = scratch("order");
        let library = Library::in_memory().unwrap();
        for id in ["WEB", "AMP", "NIV"] {
            let file = pack_file(&dir, id, &[(1, "Genesis", 1, 1, "In the beginning")]);
            library.install(&pack(id, 1), &file).unwrap();
        }

        let listed: Vec<String> =
            library.translations().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(listed, ["AMP", "NIV", "WEB"]);
    }

    /// A removal outlives the launch that made it.
    ///
    /// `ensure_bundled_translations` fills an empty library on first run and
    /// cannot otherwise tell "never had it" from "did not want it", so without
    /// the refusal being written down, Remove is a button that works until
    /// Sunday. Downloading it again clears the refusal, because a translation
    /// asked for should behave like one never removed.
    #[test]
    fn a_removal_is_remembered_and_a_reinstall_forgets_it() {
        let dir = scratch("declined");
        let library = Library::in_memory().unwrap();
        let first = pack_file(&dir, "AAA", &[(1, "Genesis", 1, 1, "In the beginning")]);
        let second = pack_file(&dir, "BBB", &[(1, "Genesis", 1, 1, "In the beginning")]);
        library.install(&pack("AAA", 1), &first).unwrap();
        library.install(&pack("BBB", 1), &second).unwrap();

        library.remove("AAA").unwrap();
        assert_eq!(library.declined().unwrap(), vec!["AAA".to_string()]);

        library.install(&pack("AAA", 1), &first).unwrap();
        assert!(library.declined().unwrap().is_empty());
    }

    /// The last one stays. An application for putting scripture on a screen
    /// should not offer a button that leaves it with no scripture.
    #[test]
    fn will_not_remove_the_only_translation() {
        let dir = scratch("last");
        let library = Library::in_memory().unwrap();
        let file = pack_file(&dir, "AAA", &[(1, "Genesis", 1, 1, "In the beginning")]);
        library.install(&pack("AAA", 1), &file).unwrap();

        assert!(library.remove("AAA").is_err());
        assert_eq!(library.translations().unwrap().len(), 1);
    }

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
