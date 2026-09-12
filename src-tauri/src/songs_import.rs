//! Songs a church already has, wherever it keeps them.
//!
//! # Why this is the first piece of the songs work
//!
//! A church running EasyWorship or OpenLP has four hundred songs in it, typed
//! by somebody over years. Asking them to retype that is asking them not to
//! switch, and no library we ship can substitute for the songs *they* sing.
//! Everything else about songs -- a bigger public-domain corpus, a licensed
//! catalogue -- is additive; this is the part that removes a reason not to
//! try Pulpitry at all.
//!
//! It is also the honest route to contemporary music. A church with a CCLI
//! licence may already reproduce the songs it covers; what it types or imports
//! is its own act under its own licence. Nothing here fetches lyrics from
//! anywhere: every song comes from a file the operator points at.
//!
//! # What is claimed about rights, which is nothing
//!
//! An imported song's status is [`RightsStatus::Unknown`], because that is
//! true: we know what the file said and not whether the church may use it.
//! Author, copyright line and CCLI number are carried through verbatim when
//! the source has them -- they are the evidence a church needs for its own
//! reporting -- and the source is recorded so the claim can be traced. An
//! unanswered question should look unanswered.
//!
//! # The formats
//!
//! - **OpenSong**: one XML file per song, lyrics as `[V1]`-tagged blocks.
//! - **OpenLyrics**: one XML file per song; what OpenLP exports and several
//!   other applications read.
//! - **OpenLP**: its whole library in one SQLite database, lyrics as XML
//!   inside a column.
//! - **Pasted text**: whatever somebody has in an email or a document.
//!
//! - **EasyWorship** (6 and 7): a SQLite database whose words are RTF, so it
//!   needs an RTF reader as well as a schema.
//!
//! EasyWorship 2009 and earlier kept Paradox database files instead, which are
//! a different job and are not read here. A church on one of those can export
//! to a newer EasyWorship, or paste.

use std::path::Path;

use anyhow::{anyhow, Context, Result};

use crate::catalog::{RightsStatus, SongRights, SongSection};

/// One song, as it arrived from somewhere else.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    pub title: String,
    pub sections: Vec<SongSection>,
    pub rights: SongRights,
}

/// An imported song as a row of the library.
///
/// # Why this is here rather than at the call site
///
/// Because the call site got it wrong, silently, for every format. It built the
/// row inline with an empty subtitle -- and the subtitle is where a song's
/// author is *shown*: under the title in the library, and in the Author box on
/// the song screen. So every import read the author faithfully out of the file,
/// stored it in the rights where nothing looks, and presented four hundred
/// songs by nobody.
///
/// One place, with a test, so the next format to be added cannot repeat it.
pub fn as_item(song: &Imported) -> crate::catalog::Item {
    /*
     * Who wrote the words, or failing that who wrote the tune.
     *
     * A hymn's text is often the interesting half -- "Charles Wesley" is what
     * an operator searches for -- but a file that names only a composer should
     * still show a name rather than nothing.
     */
    let by = if song.rights.author.trim().is_empty() {
        song.rights.composer.trim()
    } else {
        song.rights.author.trim()
    };

    crate::catalog::Item {
        id: None,
        title: song.title.trim().to_string(),
        subtitle: by.to_string(),
        body: crate::catalog::ItemBody::Song {
            sections: song.sections.clone(),
            rights: song.rights.clone(),
        },
        path: None,
        updated_at: 0,
    }
}

/// A block of a song. Components, layout and elements belong to slides.
fn section(label: impl Into<String>, lines: Vec<String>) -> SongSection {
    SongSection { label: label.into(), lines, components: None, layout: None, elements: None }
}

/**
 * A section label in the words an operator uses.
 *
 * Every one of these formats labels blocks in its own shorthand -- `V1`, `v1`,
 * `type="v" label="1"` -- and a worship leader calls for "verse two" and "the
 * bridge". The shorthand is translated once, here, so the library reads the
 * same whatever it was imported from.
 *
 * An unrecognised tag is kept as it was rather than guessed at: a church that
 * labels something "Interlude" in OpenSong should find "Interlude" here.
 */
fn label_for(tag: &str, number: Option<&str>) -> String {
    let name = match tag.to_ascii_lowercase().as_str() {
        "v" => "Verse",
        "c" => "Chorus",
        "b" => "Bridge",
        "p" => "Pre-chorus",
        "t" => "Tag",
        "e" => "Ending",
        "i" => "Intro",
        "o" => "Outro",
        other => {
            // Not a shorthand at all: a name somebody typed.
            let mut kept = other.to_string();
            if let Some(first) = kept.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            return match number {
                Some(n) if !n.is_empty() => format!("{kept} {n}"),
                _ => kept,
            };
        }
    };
    match number {
        Some(n) if !n.is_empty() && n != "1" => format!("{name} {n}"),
        Some(n) if n == "1" && name == "Verse" => "Verse 1".to_string(),
        _ => name.to_string(),
    }
}

/// Splits a tag like `v1`, `c`, `b2` into its letter and its number.
fn split_tag(tag: &str) -> (&str, Option<&str>) {
    let cut = tag.find(|c: char| c.is_ascii_digit()).unwrap_or(tag.len());
    let (letters, digits) = tag.split_at(cut);
    if letters.is_empty() {
        // A block labelled only with a number, which OpenSong allows.
        return ("v", Some(digits));
    }
    (letters, if digits.is_empty() { None } else { Some(digits) })
}

/// Whether a line is one of the things a lyric file carries that a screen must not.
///
/// OpenSong puts guitar chords on lines beginning `.` and comments on lines
/// beginning `;`. Projected, they are gibberish above the words.
fn is_furniture(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('.') || trimmed.starts_with(';')
}

/// One OpenSong file.
pub fn from_opensong(xml: &str) -> Result<Imported> {
    let document = roxmltree::Document::parse(xml).context("this is not an OpenSong song file")?;
    let root = document.root_element();
    let child = |name: &str| {
        root.children()
            .find(|node| node.has_tag_name(name))
            .and_then(|node| node.text())
            .unwrap_or_default()
            .trim()
            .to_string()
    };

    let title = child("title");
    if title.is_empty() {
        return Err(anyhow!("the song has no title"));
    }

    let mut sections = Vec::new();
    let mut label: Option<String> = None;
    let mut lines: Vec<String> = Vec::new();
    let flush = |label: &mut Option<String>, lines: &mut Vec<String>, sections: &mut Vec<SongSection>| {
        if lines.iter().any(|line| !line.trim().is_empty()) {
            let named = label.take().unwrap_or_else(|| "Verse 1".to_string());
            sections.push(section(named, std::mem::take(lines)));
        } else {
            *label = None;
            lines.clear();
        }
    };

    for line in child("lyrics").lines() {
        let trimmed = line.trim();
        if let Some(tag) = trimmed.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            flush(&mut label, &mut lines, &mut sections);
            let (letters, number) = split_tag(tag);
            label = Some(label_for(letters, number));
            continue;
        }
        if is_furniture(line) {
            continue;
        }
        /*
         * A leading digit is OpenSong's way of stacking verses in one block:
         * "1 line" belongs to verse one, "2 line" to verse two. Rare, and when
         * it appears the digit must not reach the screen.
         */
        let words = line.trim_start();
        let cleaned = match words.split_once(' ') {
            Some((first, rest)) if first.len() == 1 && first.chars().all(|c| c.is_ascii_digit()) => rest,
            _ => words,
        };
        lines.push(cleaned.trim_end().to_string());
    }
    flush(&mut label, &mut lines, &mut sections);

    if sections.is_empty() {
        return Err(anyhow!("the song has no words"));
    }

    Ok(Imported {
        title,
        sections,
        rights: SongRights {
            status: RightsStatus::Unknown,
            author: child("author"),
            composer: String::new(),
            terms: child("copyright"),
            source: "Imported from OpenSong".into(),
            ccli: child("ccli"),
        },
    })
}

/// One OpenLyrics file, which is also what OpenLP exports.
pub fn from_openlyrics(xml: &str) -> Result<Imported> {
    let document = roxmltree::Document::parse(xml).context("this is not an OpenLyrics song file")?;
    let root = document.root_element();
    let text_of = |name: &str| {
        root.descendants()
            .find(|node| node.has_tag_name(name))
            .and_then(|node| node.text())
            .unwrap_or_default()
            .trim()
            .to_string()
    };

    let title = text_of("title");
    if title.is_empty() {
        return Err(anyhow!("the song has no title"));
    }

    // Several authors are ordinary: words by one person, tune by another.
    let authors: Vec<String> = root
        .descendants()
        .filter(|node| node.has_tag_name("author"))
        .filter_map(|node| node.text())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();

    let mut sections = Vec::new();
    for verse in root.descendants().filter(|node| node.has_tag_name("verse")) {
        let name = verse.attribute("name").unwrap_or("v");
        let (letters, number) = split_tag(name);
        let mut lines = Vec::new();
        for block in verse.children().filter(|node| node.has_tag_name("lines")) {
            // `<br/>` is the line break, and a chord is an element whose text
            // is not sung. Walking the children keeps the breaks and drops the
            // chords without losing the words beside them.
            let mut current = String::new();
            for node in block.descendants() {
                if node.has_tag_name("br") {
                    lines.push(std::mem::take(&mut current).trim().to_string());
                } else if node.is_text() {
                    if node.parent().is_some_and(|parent| parent.has_tag_name("comment")) {
                        continue;
                    }
                    current.push_str(node.text().unwrap_or_default());
                }
            }
            let last = current.trim().to_string();
            if !last.is_empty() {
                lines.push(last);
            }
        }
        if lines.iter().any(|line| !line.trim().is_empty()) {
            sections.push(section(label_for(letters, number), lines));
        }
    }

    if sections.is_empty() {
        return Err(anyhow!("the song has no words"));
    }

    Ok(Imported {
        title,
        sections,
        rights: SongRights {
            status: RightsStatus::Unknown,
            author: authors.join(", "),
            composer: String::new(),
            terms: text_of("copyright"),
            source: "Imported from OpenLyrics".into(),
            ccli: text_of("ccliNo"),
        },
    })
}

/// Words pasted from an email, a document, or anywhere else.
///
/// # What it has to work out
///
/// Blank lines separate blocks; a block whose first line is a label -- "Chorus",
/// "Verse 2", "Bridge" -- is that section, and the label does not belong on the
/// screen. A block with no label is the next verse. That is the shape almost
/// every song on the internet is written in, and getting it wrong costs an
/// operator less than retyping: they can edit a section, but they will not
/// retype forty.
pub fn from_plain(title: &str, text: &str) -> Result<Imported> {
    let sections = sections_from_text(text);

    if sections.is_empty() {
        return Err(anyhow!("there are no words here"));
    }

    Ok(Imported {
        title: title.trim().to_string(),
        sections,
        rights: SongRights {
            status: RightsStatus::Unknown,
            source: "Typed or pasted in".into(),
            ..SongRights::default()
        },
    })
}

/// Blocks of words, split and labelled the way people write songs down.
///
/// Shared by the paste box and by EasyWorship, whose words arrive as one run of
/// RTF with blank lines between what it calls slides -- which is the same
/// problem, once the RTF is gone.
/// Breaking a song's words into its parts.
///
/// # Two things can start a part, and it has to be both
///
/// A blank line, which is how a typed lyric sheet separates verses, **and** a
/// label on its own line, which is how every presentation program's export
/// does it. This split on blank lines alone and looked at only the first line
/// of each block for a name -- so an EasyWorship song, whose paragraphs run one
/// after another with no blank line anywhere, arrived as a single part called
/// "Intro" with "Verse 1" and "Chorus" sitting inside it as though they were
/// words somebody sings.
///
/// That is the whole of this function's difficulty: a label is a label
/// wherever it appears, and a blank line is a break whether or not a label
/// follows it.
///
/// # A label with nothing under it
///
/// Dropped. In these exports a bare "Chorus" between two verses means *sing
/// the chorus again*, and there is nothing to put on a screen for it: an empty
/// part would be a blank projector in the middle of a song. The operator
/// presses the chorus again instead, which is what they would do anyway.
fn sections_from_text(text: &str) -> Vec<SongSection> {
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;
    // Only the parts nobody named get numbered, and they are numbered in the
    // order they appear rather than by how many parts there are.
    let mut unnamed = 0;

    let mut flush = |section: Option<(String, Vec<String>)>, into: &mut Vec<_>| {
        if let Some((label, lines)) = section {
            if !lines.is_empty() {
                into.push((label, lines));
            }
        }
    };

    for line in text.replace("\r\n", "\n").lines() {
        let line = line.trim();

        if line.is_empty() {
            flush(current.take(), &mut sections);
            continue;
        }

        if let Some(label) = looks_like_label(line) {
            flush(current.take(), &mut sections);
            current = Some((label, Vec::new()));
            continue;
        }

        match current.as_mut() {
            Some((_, lines)) => lines.push(line.to_string()),
            None => {
                unnamed += 1;
                current = Some((format!("Verse {unnamed}"), vec![line.to_string()]));
            }
        }
    }
    flush(current.take(), &mut sections);

    sections
        .into_iter()
        .map(|(label, lines)| section(label, lines))
        .collect()
}

/// Whether a line is a section heading rather than a line of the song.
///
/// Deliberately narrow. "Chorus" is a heading; "Chorus of angels sing" is a
/// lyric, and a rule loose enough to catch the second would eat a line of
/// somebody's song.
fn looks_like_label(line: &str) -> Option<String> {
    /*
     * The wrappers a label arrives in.
     *
     * "[Verse 1]" from OpenSong and anything that has been through a text
     * editor, "(Chorus)" from a lyric sheet, "VERSE 1:" from EasyWorship.
     * Stripped before the name is read, because the brackets are punctuation
     * around the label rather than part of it.
     */
    let bare = line
        .trim()
        .trim_start_matches(['[', '(', '{'])
        .trim_end_matches([']', ')', '}'])
        .trim()
        .trim_end_matches([':', '.'])
        .trim();
    if bare.split_whitespace().count() > 2 || bare.len() > 16 {
        return None;
    }
    let lower = bare.to_ascii_lowercase();

    // Two-word names, which the word-and-number reading below cannot see: the
    // second word is not a number, so it would refuse them.
    match lower.replace(['-', '_'], " ").as_str() {
        "pre chorus" => return Some("Pre-chorus".to_string()),
        "post chorus" => return Some("Post-chorus".to_string()),
        _ => {}
    }
    let (word, number) = match lower.split_once(char::is_whitespace) {
        Some((word, rest)) => (word, rest.trim().to_string()),
        None => {
            // "verse2" and "v2" as well as "verse 2".
            let cut = lower.find(|c: char| c.is_ascii_digit()).unwrap_or(lower.len());
            (&lower[..cut], lower[cut..].to_string())
        }
    };
    if !number.is_empty() && !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let name = match word {
        "verse" | "v" => "Verse",
        "chorus" | "c" | "refrain" => "Chorus",
        "bridge" | "b" => "Bridge",
        "pre-chorus" | "prechorus" | "p" => "Pre-chorus",
        "tag" | "t" => "Tag",
        "ending" | "outro" | "coda" => "Ending",
        "intro" => "Intro",
        // Parts with no words of their own, which these exports label anyway.
        // Kept as names: a section with nothing under it is dropped, and one
        // that does carry words -- an instrumental with a spoken line over it
        // -- is a part the operator may want.
        "vamp" => "Vamp",
        "interlude" | "instrumental" => "Interlude",
        _ => return None,
    };
    Some(match number.as_str() {
        "" => name.to_string(),
        n => format!("{name} {n}"),
    })
}

/// A whole OpenLP library, from the database file it keeps it in.
///
/// One file holds every song, which is why this returns a list where the file
/// formats return one: an operator points at `songs.sqlite` once and has their
/// library, rather than at four hundred files.
///
/// Opened read-only. It is the church's own library and this must not be the
/// thing that damages it.
pub fn from_openlp(path: &Path) -> Result<Vec<Imported>> {
    use rusqlite::{Connection, OpenFlags};

    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("could not open {}", path.display()))?;

    let mut statement = connection
        .prepare(
            "SELECT s.id, s.title, s.lyrics, s.copyright, s.ccli_number \
             FROM songs s ORDER BY s.title",
        )
        .context("this does not look like an OpenLP song database")?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut songs = Vec::new();
    for (id, title, lyrics, copyright, ccli) in rows {
        // A song whose lyrics will not parse is skipped rather than fatal: one
        // damaged row must not cost a church the other three hundred.
        let Ok(sections) = openlp_sections(&lyrics) else { continue };
        if sections.is_empty() || title.trim().is_empty() {
            continue;
        }
        songs.push(Imported {
            title: title.trim().to_string(),
            sections,
            rights: SongRights {
                status: RightsStatus::Unknown,
                author: openlp_authors(&connection, id).unwrap_or_default(),
                composer: String::new(),
                terms: copyright.trim().to_string(),
                source: "Imported from OpenLP".into(),
                ccli: ccli.trim().to_string(),
            },
        });
    }

    Ok(songs)
}

/// The verses inside OpenLP's own lyrics column, which is XML.
fn openlp_sections(lyrics: &str) -> Result<Vec<SongSection>> {
    let document = roxmltree::Document::parse(lyrics)?;
    let mut sections = Vec::new();
    for verse in document.root_element().descendants().filter(|node| node.has_tag_name("verse")) {
        let tag = verse.attribute("type").unwrap_or("v");
        let number = verse.attribute("label");
        let text = verse.text().unwrap_or_default();
        let lines: Vec<String> = text
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if !lines.is_empty() {
            sections.push(section(label_for(tag, number), lines));
        }
    }
    Ok(sections)
}

/// Who OpenLP recorded as the authors of one song.
fn openlp_authors(connection: &rusqlite::Connection, song: i64) -> Result<String> {
    let mut statement = connection.prepare(
        "SELECT a.display_name FROM authors a \
         JOIN authors_songs js ON js.author_id = a.id \
         WHERE js.song_id = ?1",
    )?;
    let names = statement
        .query_map([song], |row| row.get::<_, Option<String>>(0))?
        .filter_map(|name| name.ok().flatten())
        .filter(|name| !name.trim().is_empty())
        .collect::<Vec<_>>();
    Ok(names.join(", "))
}


/**
 * A whole EasyWorship library, from the database the application keeps.
 *
 * Versions 6 and 7 store songs in SQLite: a `song` table for the titles and
 * credits, and a `word` table holding the lyrics as RTF. The RTF is why this
 * is more than a query -- EasyWorship writes fonts, colours and view state
 * around the words, and none of that belongs anywhere near a screen.
 *
 * The columns are read from the schema rather than assumed, because they differ
 * between versions and a missing `reference_number` should cost the church a
 * CCLI number rather than the import.
 *
 * Opened read-only: it is the church's own library and this must not be what
 * damages it.
 */
pub fn from_easyworship(path: &Path) -> Result<Vec<Imported>> {
    use rusqlite::{Connection, OpenFlags};

    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("could not open {}", path.display()))?;

    let has = |table: &str, column: &str| -> bool {
        connection
            .prepare(&format!("SELECT {column} FROM {table} LIMIT 0"))
            .is_ok()
    };
    if !has("song", "title") || !has("word", "words") {
        return Err(anyhow!(
            "{} is not an EasyWorship song database",
            path.file_name().and_then(|name| name.to_str()).unwrap_or("that file")
        ));
    }

    // Absent in some versions; asked for only where the schema has it.
    let author = if has("song", "author") { "s.author" } else { "''" };
    let copyright = if has("song", "copyright") { "s.copyright" } else { "''" };
    let ccli = if has("song", "reference_number") { "s.reference_number" } else { "''" };

    let sql = format!(
        "SELECT s.title, {author}, {copyright}, {ccli}, w.words \
         FROM song s JOIN word w ON w.song_id = s.rowid ORDER BY s.title"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut songs = Vec::new();
    for (title, author, copyright, ccli, words) in rows {
        let sections = sections_from_text(&strip_rtf(&words));
        if title.trim().is_empty() || sections.is_empty() {
            continue;
        }
        songs.push(Imported {
            title: title.trim().to_string(),
            sections,
            rights: SongRights {
                status: RightsStatus::Unknown,
                author: author.trim().to_string(),
                composer: String::new(),
                terms: copyright.trim().to_string(),
                source: "Imported from EasyWorship".into(),
                ccli: ccli.trim().to_string(),
            },
        });
    }

    Ok(songs)
}

/**
 * The words out of RTF, and nothing else.
 *
 * Not a general RTF reader: a lyric needs the text, the line breaks and the
 * accented characters, and nothing RTF says about fonts, colours or windows.
 *
 * The four things that actually matter in EasyWorship's output:
 *
 * - `\par` and `\line` are where a line ends. Everything else is discarded,
 *   so a missed one would run two lines of a verse together.
 * - `{\*\...}` groups are destinations meant for the application rather than
 *   the reader -- generators, colour tables, stylesheets -- and are skipped
 *   whole, because their *contents* are not text either.
 * - `\uN` is a real character, often an accent in a name; `\'XX` is one in
 *   Windows-1252. Dropping those silently would mangle somebody's language.
 * - A control word swallows one following space, which is RTF's own rule and
 *   the difference between "Lordis" and "Lord is".
 */
fn strip_rtf(rtf: &str) -> String {
    let bytes: Vec<char> = rtf.chars().collect();
    let mut out = String::with_capacity(rtf.len() / 2);
    let mut at = 0;
    // Depth of a `{\*\...}` group we are inside and ignoring.
    let mut skipping: Option<usize> = None;
    let mut depth = 0usize;

    while at < bytes.len() {
        let c = bytes[at];
        match c {
            '{' => {
                depth += 1;
                if skipping.is_none() && opens_a_destination(&bytes, at) {
                    skipping = Some(depth);
                }
                at += 1;
            }
            '}' => {
                if skipping == Some(depth) {
                    skipping = None;
                }
                depth = depth.saturating_sub(1);
                at += 1;
            }
            '\\' => {
                at += 1;
                match bytes.get(at) {
                    // An escaped brace or backslash is that character.
                    Some(&escaped @ ('{' | '}' | '\\')) => {
                        if skipping.is_none() {
                            out.push(escaped);
                        }
                        at += 1;
                    }
                    // A byte in Windows-1252, written as two hex digits.
                    Some(&'\'') => {
                        let hex: String = bytes.iter().skip(at + 1).take(2).collect();
                        if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                            if skipping.is_none() {
                                out.push(cp1252(byte));
                            }
                        }
                        at += 3;
                    }
                    Some(_) => {
                        let start = at;
                        while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
                            at += 1;
                        }
                        let word: String = bytes[start..at].iter().collect();
                        // A signed number may follow: \fs40, \u241, \li-720.
                        let digits_at = at;
                        if bytes.get(at) == Some(&'-') {
                            at += 1;
                        }
                        while at < bytes.len() && bytes[at].is_ascii_digit() {
                            at += 1;
                        }
                        let number: String = bytes[digits_at..at].iter().collect();
                        // RTF's rule: one space after a control word is its
                        // delimiter and not part of the text.
                        if bytes.get(at) == Some(&' ') {
                            at += 1;
                        }
                        if skipping.is_some() {
                            continue;
                        }
                        match word.as_str() {
                            "par" | "line" | "row" => out.push('\n'),
                            "tab" => out.push('\t'),
                            "u" => {
                                if let Ok(code) = number.parse::<i64>() {
                                    // Negative values are the same character
                                    // written as a signed 16-bit integer.
                                    let code = if code < 0 { (code + 65_536) as u32 } else { code as u32 };
                                    if let Some(ch) = char::from_u32(code) {
                                        out.push(ch);
                                    }
                                }
                                // The replacement character that follows a \u
                                // is for readers that cannot do Unicode.
                                if bytes.get(at) == Some(&'?') {
                                    at += 1;
                                }
                            }
                            _ => {}
                        }
                    }
                    None => break,
                }
            }
            '\n' | '\r' => {
                // Raw newlines in RTF are formatting, not line breaks.
                at += 1;
            }
            _ => {
                if skipping.is_none() {
                    out.push(c);
                }
                at += 1;
            }
        }
    }

    out
}

/**
 * Whether a group opens something that is not text.
 *
 * `{\*\...}` says so explicitly, and RTF readers are expected to know the
 * rest by name: the font and colour tables, the stylesheet, the document
 * information, an embedded picture. Their contents are data, not words, and
 * the test that caught this found "Arial" and a run of semicolons in the
 * middle of a hymn.
 */
fn opens_a_destination(chars: &[char], brace_at: usize) -> bool {
    if chars.get(brace_at + 1) != Some(&'\\') {
        return false;
    }
    if chars.get(brace_at + 2) == Some(&'*') {
        return true;
    }
    let word: String = chars
        .iter()
        .skip(brace_at + 2)
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    matches!(
        word.as_str(),
        "fonttbl"
            | "colortbl"
            | "stylesheet"
            | "listtable"
            | "listoverridetable"
            | "revtbl"
            | "rsidtbl"
            | "info"
            | "pict"
            | "object"
            | "themedata"
            | "datastore"
            | "latentstyles"
            | "filetbl"
            | "xmlnstbl"
            | "generator"
            | "shppict"
            | "nonshppict"
    )
}

/// One byte of Windows-1252 as a character.
///
/// Only the range that differs from Latin-1 needs a table; the rest is the
/// same number. EasyWorship writes curly quotes and dashes this way constantly.
fn cp1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
        '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
        '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
        '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
    ];
    match byte {
        0x80..=0x9F => HIGH[(byte - 0x80) as usize],
        other => other as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fault every import had: the author was read and never shown.
    #[test]
    fn an_imported_song_carries_its_author_where_it_is_shown() {
        let song = Imported {
            title: "  Way Maker  ".into(),
            sections: vec![section("Verse 1", vec!["You are here".into()])],
            rights: SongRights {
                status: RightsStatus::Unknown,
                author: "Osinachi Okoro".into(),
                composer: String::new(),
                terms: "© Integrity Music".into(),
                source: "Imported from EasyWorship".into(),
                ccli: "7115744".into(),
            },
        };

        let item = as_item(&song);
        assert_eq!(item.title, "Way Maker", "the title is trimmed");
        assert_eq!(
            item.subtitle, "Osinachi Okoro",
            "the author belongs in the subtitle, which is where it is shown"
        );

        let crate::catalog::ItemBody::Song { rights, .. } = item.body else {
            panic!("a song should arrive as a song");
        };
        // And the evidence is kept as it arrived.
        assert_eq!(rights.terms, "© Integrity Music");
        assert_eq!(rights.ccli, "7115744");
    }

    /// A file that names only whoever wrote the tune still shows a name.
    #[test]
    fn a_composer_stands_in_where_there_is_no_author() {
        let song = Imported {
            title: "Hymn".into(),
            sections: vec![section("Verse 1", vec!["A line".into()])],
            rights: SongRights {
                composer: "John Bacchus Dykes".into(),
                ..SongRights::default()
            },
        };

        assert_eq!(as_item(&song).subtitle, "John Bacchus Dykes");
    }

    /// The fault a real EasyWorship export arrived with.
    ///
    /// Its paragraphs run one after another with no blank line anywhere, so
    /// splitting on blank lines gave one part called "Intro" holding the whole
    /// song -- with "Verse 1" and "Chorus" inside it as though somebody sang
    /// them. Every label starts a part, blank line or not.
    #[test]
    fn labels_start_a_part_without_a_blank_line_anywhere() {
        let sections = sections_from_text(
            "Intro\n             Yeah-yeah\n             I've seen Your power\n             Verse 1\n             I've lived stories that have proved Your faithfulness\n             And I've seen miracles my mind can't comprehend\n             Chorus\n             I believe\n             You're the wonder-working God",
        );

        let names: Vec<&str> = sections.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(names, vec!["Intro", "Verse 1", "Chorus"]);
        assert_eq!(sections[0].lines, vec!["Yeah-yeah", "I've seen Your power"]);
        assert_eq!(sections[2].lines.len(), 2);
        assert!(
            sections.iter().all(|s| !s.lines.iter().any(|line| line == "Chorus")),
            "a label must never end up as a line of the song: {sections:?}"
        );
    }

    /// Blank lines still separate parts, for songs that use them and name
    /// nothing -- a pasted lyric sheet, most often.
    #[test]
    fn blank_lines_still_separate_unnamed_parts() {
        let sections = sections_from_text(
            "Amazing grace how sweet the sound\nThat saved a wretch like me\n\n             I once was lost but now am found\nWas blind but now I see",
        );

        let names: Vec<&str> = sections.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(names, vec!["Verse 1", "Verse 2"]);
    }

    /// A label with nothing under it means "sing it again", and there is
    /// nothing to put on a screen for it. An empty part would be a blank
    /// projector in the middle of a song.
    #[test]
    fn a_bare_repeat_marker_does_not_become_an_empty_part() {
        let sections = sections_from_text(
            "Chorus\nI believe\n\nVerse 2\nI have heard\n\nChorus\n",
        );

        let names: Vec<&str> = sections.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(names, vec!["Chorus", "Verse 2"]);
        assert!(sections.iter().all(|s| !s.lines.is_empty()));
    }

    /// The wrappers a label arrives in, and the two-word names the
    /// word-and-number reading cannot see on its own.
    #[test]
    fn a_label_is_read_however_it_is_written() {
        for (written, expected) in [
            ("[Verse 2]", "Verse 2"),
            ("(Chorus)", "Chorus"),
            ("VERSE 1:", "Verse 1"),
            ("Pre-Chorus", "Pre-chorus"),
            ("pre chorus", "Pre-chorus"),
            ("Bridge", "Bridge"),
            ("Vamp", "Vamp"),
            ("Instrumental", "Interlude"),
        ] {
            assert_eq!(
                looks_like_label(written).as_deref(),
                Some(expected),
                "{written} should be read as {expected}"
            );
        }

        // And the line that must never be mistaken for one.
        assert_eq!(looks_like_label("Chorus of angels sing"), None);
        assert_eq!(looks_like_label("I believe"), None);
    }

    #[test]
    fn opensong_keeps_the_lines_where_the_writer_broke_them() {
        let song = from_opensong(
            r#"<song>
  <title>Amazing Grace</title>
  <author>John Newton</author>
  <copyright>Public Domain</copyright>
  <ccli>22025</ccli>
  <lyrics>[V1]
Amazing grace how sweet the sound
That saved a wretch like me
[C]
Praise the Lord
</lyrics>
</song>"#,
        )
        .expect("an OpenSong file");

        assert_eq!(song.title, "Amazing Grace");
        assert_eq!(song.rights.author, "John Newton");
        assert_eq!(song.rights.terms, "Public Domain");
        assert_eq!(song.rights.ccli, "22025");
        // Nothing is claimed about whether it may be used, only what was said.
        assert_eq!(song.rights.status, RightsStatus::Unknown);
        assert_eq!(song.sections.len(), 2);
        assert_eq!(song.sections[0].label, "Verse 1");
        assert_eq!(
            song.sections[0].lines,
            vec!["Amazing grace how sweet the sound", "That saved a wretch like me"],
        );
        assert_eq!(song.sections[1].label, "Chorus");
    }

    /// Chords and comments are in the file and must never reach a screen.
    #[test]
    fn opensong_drops_the_chords_and_keeps_the_words() {
        let song = from_opensong(
            "<song><title>T</title><lyrics>[V1]\n.G       C\n Holy holy holy\n; from the 1826 text\n Lord God almighty\n</lyrics></song>",
        )
        .expect("an OpenSong file");

        assert_eq!(song.sections[0].lines, vec!["Holy holy holy", "Lord God almighty"]);
    }

    /// A digit prefix says which verse a line belongs to. It is not a lyric.
    #[test]
    fn opensong_strips_the_verse_digit() {
        let song = from_opensong("<song><title>T</title><lyrics>[V]\n1 First line\n</lyrics></song>")
            .expect("an OpenSong file");
        assert_eq!(song.sections[0].lines, vec!["First line"]);
    }

    #[test]
    fn openlyrics_breaks_lines_on_br_and_ignores_chords() {
        let song = from_openlyrics(
            r#"<song xmlns="http://openlyrics.info/namespace/2009/song" version="0.8">
  <properties>
    <titles><title>Be Thou My Vision</title></titles>
    <authors><author>Dallán Forgaill</author><author>Mary Byrne</author></authors>
    <copyright>Public Domain</copyright>
    <ccliNo>30639</ccliNo>
  </properties>
  <lyrics>
    <verse name="v1"><lines>Be thou my vision<br/><chord name="G"/>O Lord of my heart</lines></verse>
    <verse name="c"><lines>Thou my best thought</lines></verse>
  </lyrics>
</song>"#,
        )
        .expect("an OpenLyrics file");

        assert_eq!(song.title, "Be Thou My Vision");
        assert_eq!(song.rights.author, "Dallán Forgaill, Mary Byrne");
        assert_eq!(song.rights.ccli, "30639");
        assert_eq!(song.sections.len(), 2);
        assert_eq!(song.sections[0].lines, vec!["Be thou my vision", "O Lord of my heart"]);
        assert_eq!(song.sections[1].label, "Chorus");
    }

    #[test]
    fn pasted_text_finds_its_own_sections() {
        let song = from_plain(
            "Great Is Thy Faithfulness",
            "Great is thy faithfulness\nO God my Father\n\nChorus\nMorning by morning\n\nVerse 2\nSummer and winter\n",
        )
        .expect("words");

        assert_eq!(
            song.sections.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(),
            vec!["Verse 1", "Chorus", "Verse 2"],
        );
        // The heading is a heading. It does not go on the screen.
        assert_eq!(song.sections[1].lines, vec!["Morning by morning"]);
    }

    /// A line that merely begins with a section word is a lyric.
    #[test]
    fn a_lyric_that_reads_like_a_heading_is_left_alone() {
        let song = from_plain("T", "Chorus of angels sing to him\nAnd all the earth replies\n")
            .expect("words");
        assert_eq!(song.sections.len(), 1);
        assert_eq!(song.sections[0].label, "Verse 1");
        assert_eq!(song.sections[0].lines.len(), 2);
    }

    #[test]
    fn a_paste_with_no_words_is_an_error_not_an_empty_song() {
        assert!(from_plain("T", "\n\n  \n").is_err());
    }

    /// An OpenLP library, read out of the shape OpenLP actually writes.
    #[test]
    fn openlp_reads_a_library_with_its_authors_and_ccli() {
        let directory = std::env::temp_dir().join(format!("pulpitry-openlp-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a temporary directory");
        let path = directory.join("songs.sqlite");

        {
            let db = rusqlite::Connection::open(&path).expect("a database");
            db.execute_batch(
                "CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, lyrics TEXT, copyright TEXT, ccli_number TEXT);
                 CREATE TABLE authors (id INTEGER PRIMARY KEY, display_name TEXT);
                 CREATE TABLE authors_songs (author_id INTEGER, song_id INTEGER);
                 INSERT INTO authors VALUES (1, 'Charles Wesley');
                 INSERT INTO authors_songs VALUES (1, 1);",
            )
            .expect("the OpenLP shape");
            db.execute(
                "INSERT INTO songs VALUES (1, ?1, ?2, ?3, ?4)",
                rusqlite::params![
                    "And Can It Be",
                    "<song version=\"1.0\"><lyrics><verse type=\"v\" label=\"1\">And can it be that I should gain\nAn interest in the Saviour's blood</verse><verse type=\"c\">Amazing love</verse></lyrics></song>",
                    "Public Domain",
                    "27288",
                ],
            )
            .expect("a song");
            // A row whose lyrics are not XML at all: skipped, not fatal.
            db.execute(
                "INSERT INTO songs VALUES (2, 'Damaged', 'not xml', '', '')",
                [],
            )
            .expect("a damaged song");
        }

        let songs = from_openlp(&path).expect("a library");
        std::fs::remove_dir_all(&directory).ok();

        assert_eq!(songs.len(), 1, "the damaged row is skipped, the good one kept");
        let song = &songs[0];
        assert_eq!(song.title, "And Can It Be");
        assert_eq!(song.rights.author, "Charles Wesley");
        assert_eq!(song.rights.ccli, "27288");
        assert_eq!(song.sections.len(), 2);
        assert_eq!(song.sections[0].label, "Verse 1");
        assert_eq!(song.sections[1].label, "Chorus");
        assert_eq!(song.sections[0].lines.len(), 2);
    }

    /// RTF carries the words, the breaks and the accents; everything else goes.
    #[test]
    fn rtf_gives_back_the_words_and_the_line_breaks() {
        let rtf = concat!(
            r"{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fnil Arial;}}",
            r"{\colortbl ;\red255\green255\blue255;}",
            r"{\*\generator EasyWorship;}",
            r"\viewkind4\uc1\pard\cf1\f0\fs40 Amazing grace how sweet the sound\par",
            "\n",
            r"That saved a wretch like me\par",
            "\n",
            r"\par",
            "\n",
            r"Chorus\par",
            "\n",
            r"Se\'f1or, praise the Lord\u241 ?\par",
            "\n}",
        );

        let text = strip_rtf(rtf);
        assert!(text.contains("Amazing grace how sweet the sound"), "got {text:?}");
        // The control word swallows its delimiting space, not the word after it.
        assert!(text.contains("That saved a wretch like me"), "got {text:?}");
        // A destination group is not text: the generator name must not appear.
        assert!(!text.contains("EasyWorship"), "got {text:?}");
        assert!(!text.contains("Arial"), "got {text:?}");
        // Both ways of writing an accent survive.
        assert!(text.contains("Señor"), "got {text:?}");
        assert!(text.contains('ñ'), "got {text:?}");
        // The blank line between slides is kept, because it is where a section ends.
        assert!(text.contains("\n\n"), "got {text:?}");
    }

    #[test]
    fn easyworship_reads_a_library_with_its_credits() {
        let directory = std::env::temp_dir().join(format!("pulpitry-ew-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a temporary directory");
        let path = directory.join("Songs.db");

        {
            let db = rusqlite::Connection::open(&path).expect("a database");
            db.execute_batch(
                "CREATE TABLE song (title TEXT, author TEXT, copyright TEXT, reference_number TEXT);
                 CREATE TABLE word (song_id INTEGER, words TEXT);",
            )
            .expect("the EasyWorship shape");
            db.execute(
                "INSERT INTO song VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params!["Way Maker", "Osinachi Okoro", "Integrity Music", "7115744"],
            )
            .expect("a song");
            db.execute(
                "INSERT INTO word VALUES (1, ?1)",
                rusqlite::params![concat!(
                    r"{\rtf1\ansi{\fonttbl{\f0\fnil Arial;}}\fs40 You are here\par",
                    "\n",
                    r"Moving in our midst\par",
                    "\n",
                    r"\par",
                    "\n",
                    r"Chorus\par",
                    "\n",
                    r"Way maker\par",
                    "\n}",
                )],
            )
            .expect("its words");
        }

        let songs = from_easyworship(&path).expect("a library");
        std::fs::remove_dir_all(&directory).ok();

        assert_eq!(songs.len(), 1);
        let song = &songs[0];
        assert_eq!(song.title, "Way Maker");
        assert_eq!(song.rights.author, "Osinachi Okoro");
        assert_eq!(song.rights.terms, "Integrity Music");
        // EasyWorship's reference number is the CCLI song number.
        assert_eq!(song.rights.ccli, "7115744");
        // Still nothing claimed about whether this church may use it.
        assert_eq!(song.rights.status, RightsStatus::Unknown);
        assert_eq!(
            song.sections.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(),
            vec!["Verse 1", "Chorus"],
        );
        assert_eq!(song.sections[0].lines, vec!["You are here", "Moving in our midst"]);
        assert_eq!(song.sections[1].lines, vec!["Way maker"]);
    }

    /// A database that is not EasyWorship's says so, rather than returning nothing.
    #[test]
    fn a_database_of_the_wrong_shape_is_named_as_such() {
        let directory = std::env::temp_dir().join(format!("pulpitry-ew-wrong-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("a temporary directory");
        let path = directory.join("Other.db");
        {
            let db = rusqlite::Connection::open(&path).expect("a database");
            db.execute_batch("CREATE TABLE something (a TEXT);").expect("a table");
        }
        let outcome = from_easyworship(&path);
        std::fs::remove_dir_all(&directory).ok();

        let message = outcome.expect_err("not an EasyWorship database").to_string();
        assert!(message.contains("EasyWorship"), "got {message}");
        assert!(message.contains("Other.db"), "the file is named: {message}");
    }

    #[test]
    fn shorthand_becomes_the_words_an_operator_uses() {
        assert_eq!(label_for("v", Some("2")), "Verse 2");
        assert_eq!(label_for("c", None), "Chorus");
        assert_eq!(label_for("b", Some("1")), "Bridge");
        assert_eq!(label_for("p", None), "Pre-chorus");
        // A name somebody typed is kept as theirs.
        assert_eq!(label_for("interlude", None), "Interlude");
    }
}
