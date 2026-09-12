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
//! EasyWorship is next and is not here yet: version 6 and 7 keep a SQLite
//! database whose words are RTF, so it needs an RTF reader as well as a
//! schema, and it is worth doing properly rather than half.

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

/// A block of a song. `components` and `layout` belong to slides, not songs.
fn section(label: impl Into<String>, lines: Vec<String>) -> SongSection {
    SongSection { label: label.into(), lines, components: None, layout: None }
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
    let mut sections = Vec::new();
    let mut verse = 0;

    for block in text.replace("\r\n", "\n").split("\n\n") {
        let lines: Vec<&str> = block.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
        if lines.is_empty() {
            continue;
        }

        let (label, words) = match looks_like_label(lines[0]) {
            Some(label) if lines.len() > 1 => (label, &lines[1..]),
            _ => {
                verse += 1;
                (format!("Verse {verse}"), &lines[..])
            }
        };
        sections.push(section(label, words.iter().map(|line| line.to_string()).collect()));
    }

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

/// Whether a line is a section heading rather than a line of the song.
///
/// Deliberately narrow. "Chorus" is a heading; "Chorus of angels sing" is a
/// lyric, and a rule loose enough to catch the second would eat a line of
/// somebody's song.
fn looks_like_label(line: &str) -> Option<String> {
    let bare = line.trim().trim_end_matches(':').trim();
    if bare.split_whitespace().count() > 2 || bare.len() > 16 {
        return None;
    }
    let lower = bare.to_ascii_lowercase();
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
        "ending" | "outro" => "Ending",
        "intro" => "Intro",
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

#[cfg(test)]
mod tests {
    use super::*;

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
