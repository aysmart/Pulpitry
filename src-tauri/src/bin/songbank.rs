//! Builds the Song Finder pack from a church's own song library.
//!
//! # What it makes
//!
//! One SQLite file — the pack — holding every song once, its words already
//! sectioned, and a vector per song so a machine that has downloaded it can
//! search by meaning with nothing on the network. It is built here, once, and
//! shipped: no church's machine does the embedding pass, and every one of them
//! searches against identical vectors.
//!
//! # Why it reuses the app's own code
//!
//! The sectioner is `songs_import`, the same one a church's own import runs
//! through, so a song from the bank breaks into verses exactly as a song they
//! imported themselves does. The embedder is the one the app carries, so the
//! query a machine embeds at search time lands in the same space as the
//! vectors in the pack. Either of those written twice would be two things to
//! keep in step, and the failure would be silent: a bank that answers slightly
//! wrong questions.
//!
//! # Running it
//!
//! ```text
//! cargo run --bin songbank -- Songs.db songfinder.db [embedder] [keep.txt]
//! ```
//!
//! It writes the pack, and beside it a list of every song it left out. Read
//! that, add authors or titles to `keep.txt`, run it again.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use pulpitry_lib::catalog::SongSection;
use pulpitry_lib::songs_import::{self, Imported};
use rusqlite::Connection;

/// How many songs are embedded at once.
///
/// The cost is dominated by matrix multiplies that do far better over a batch
/// than one at a time, and the ceiling is memory: thirty-two songs of about
/// four hundred tokens is comfortable on any machine that can build this.
const BATCH: usize = 32;

/// What a search is matched against.
///
/// Not the whole song. The model reads 512 tokens and a full lyric runs past
/// that, so the tail would be cut off arbitrarily — and worse, a whole lyric
/// averages into a vector that says "this is a worship song", which every one
/// of them says. People ask for a song by its title, by who sings it, by the
/// line they remember and by what the chorus is about, so that is what goes
/// in.
fn searchable(song: &Imported) -> String {
    let opening = opening_line(&song.sections);
    let chorus = song
        .sections
        .iter()
        .find(|section| section.label.to_lowercase().contains("chorus"))
        .map(|section| section.lines.join(" "))
        .unwrap_or_default();

    let mut text = format!("{} — {}", song.title, song.rights.author);
    for part in [opening.as_str(), chorus.as_str()] {
        if !part.trim().is_empty() {
            text.push_str(". ");
            text.push_str(part.trim());
        }
    }
    text
}

/// The first line anybody would sing, which is how half a congregation names a
/// song — skipping the labels, which name nothing.
fn opening_line(sections: &[SongSection]) -> String {
    sections
        .iter()
        .flat_map(|section| section.lines.iter())
        .find(|line| !line.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

/// Letters and digits only: the key two copies of one song agree on.
fn normalised(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/**
 * A stable id for a song, from what the song *is*.
 *
 * Not the row number it happened to have in somebody's library: the pack is
 * rebuilt whenever the bank grows, and an id that moved would turn every
 * church's saved reference to a song into a reference to a different one.
 * Title and opening line, normalised, hashed — the same two things the
 * deduplication agrees on, so a song cannot have two ids in one pack.
 */
fn id_for(title: &str, opening: &str) -> String {
    // FNV-1a, 64-bit: a hash for naming rather than for secrecy, and short
    // enough to read in a log.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalised(title).bytes().chain(b"/".iter().copied()).chain(normalised(opening).bytes()) {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/**
 * A vector as half precision.
 *
 * Halves the pack — eight megabytes against sixteen for eleven thousand songs
 * — and costs nothing that matters: these are unit vectors whose components
 * sit well inside half precision's range, and the ranking is by cosine, where
 * a thousandth of a degree changes no order anybody could notice.
 */
fn to_half(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x007f_ffff;

    if exponent <= 0 {
        // Underflow to zero: a component this small contributes nothing to a
        // cosine against a unit vector.
        return sign;
    }
    if exponent >= 0x1f {
        return sign | 0x7c00;
    }
    sign | ((exponent as u16) << 10) | ((mantissa >> 13) as u16)
}

fn pack_vector(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 2);
    for value in vector {
        bytes.extend_from_slice(&to_half(*value).to_le_bytes());
    }
    bytes
}

/**
 * Whether a song reads as something a church would sing.
 *
 * A personal library is a personal library: a third of this one has no
 * religious word in it anywhere, because it is the music somebody owns rather
 * than the music their church sings. A Song Finder sold to churches that
 * answers "the one about waiting" with a pop record is not a bonus, it is a
 * wrong answer given under time pressure in front of a congregation.
 *
 * The test is deliberately crude and deliberately not the last word: it is a
 * sieve, and everything it rejects is written out to be read by a person. A
 * cleverer classifier would be harder to argue with and no more right -- there
 * is no model that knows which songs *this* church sings, and the person
 * building the bank does.
 */
fn reads_as_worship(song: &Imported) -> bool {
    /*
     * In every language the library is actually in.
     *
     * An English-only list threw out every Spanish worship song in the
     * collection -- Marcos Witt, Jesús Adrián Romero, Miel San Marcos, a
     * hundred each -- because not one of them says "Lord". That is not a near
     * miss, it is the sieve being wrong about a whole language, and this app
     * ships Bibles in nine of them.
     *
     * Generous on purpose. A word that also appears in ordinary songs -- amor,
     * gloria, heart -- is not here, but the borderline is set to keep rather
     * than to cut, because what it keeps is read by an operator choosing a
     * song and what it cuts is read by nobody.
     */
    const WORDS: &[&str] = &[
        // English
        "jesus", "christ", "god", "lord", "hallelujah", "alleluia", "praise",
        "worship", "saviour", "savior", "almighty", "hosanna", "amen", "holy",
        "gospel", "salvation", "redeem", "grace", "glory", "faith", "heaven",
        "spirit", "church", "bless", "pray", "cross", "kingdom", "mercy",
        "hymn", "psalm", "shepherd", "angel", "eternal",
        // Spanish and Portuguese
        "dios", "deus", "senhor", "señor", "senor", "cristo", "jesús",
        "espíritu", "espirito", "santo", "alabanza", "alabar", "adoración",
        "adoracion", "adoração", "adorar", "aleluya", "salvador", "salvação",
        "salvacion", "iglesia", "igreja", "oración", "oracao", "bendición",
        "bendicion", "bênção", "misericordia", "misericórdia", "gracia",
        "graça", "reino", "cordero", "cordeiro", "aleluia",
        // French, Italian, German
        "seigneur", "dieu", "esprit", "louange", "adoration", "église",
        "signore", "gesù", "spirito", "lode", "chiesa", "herr", "gott",
        "heilig", "gnade", "kirche", "ehre sei",
        // Yoruba, Igbo, Hausa, Swahili, Twi, Zulu
        "oluwa", "jesu", "olorun", "ọlọrun", "chineke", "chukwu", "jisos",
        "allah", "ubangiji", "yesu", "mungu", "bwana", "roho", "nyame",
        "awurade", "jehova", "jehovah", "nkosi", "yahweh", "immanuel",
        "emmanuel",
    ];

    let mut haystack = song.title.to_lowercase();
    for section in &song.sections {
        for line in &section.lines {
            haystack.push(' ');
            haystack.push_str(&line.to_lowercase());
        }
    }
    WORDS.iter().any(|word| haystack.contains(word))
}

/// One name as it is matched: letters and digits, lower case.
fn keyed(text: &str) -> String {
    normalised(text)
}

/**
 * What was left out, for somebody to read.
 *
 * Grouped by author and heaviest first, because that is how it is actually
 * reviewed: one artist is one decision about a dozen songs, and a list of
 * three thousand titles in alphabetical order is a list nobody finishes.
 */
fn write_review(path: &Path, left_out: &[&Imported]) -> Result<()> {
    let mut by_author: HashMap<String, Vec<&Imported>> = HashMap::new();
    for song in left_out {
        by_author
            .entry(song.rights.author.trim().to_string())
            .or_default()
            .push(song);
    }
    let mut authors: Vec<_> = by_author.into_iter().collect();
    authors.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));

    let mut out = std::fs::File::create(path)?;
    writeln!(
        out,
        "# Left out of the pack: no religious word in the title or the words.\n\
         #\n\
         # Put a line in keep.txt to bring one back -- an author's name keeps\n\
         # everything of theirs, a title keeps that song. Everything here is a\n\
         # guess by a word list, so the ones worth arguing with are the point.\n"
    )?;
    for (author, songs) in authors {
        writeln!(
            out,
            "\n{} ({} song{})",
            if author.is_empty() { "(no author)" } else { &author },
            songs.len(),
            if songs.len() == 1 { "" } else { "s" }
        )?;
        let mut titles: Vec<&str> = songs.iter().map(|song| song.title.as_str()).collect();
        titles.sort_unstable();
        for title in titles {
            writeln!(out, "    {title}")?;
        }
    }
    Ok(())
}

/// Authors and titles to keep whatever the sieve says, one per line.
fn read_keep(path: &Path) -> HashSet<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(keyed)
        .collect()
}

fn write_pack(path: &Path, songs: &[(Imported, Vec<f32>)]) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path).with_context(|| format!("could not replace {}", path.display()))?;
    }
    let connection = Connection::open(path)?;
    connection.execute_batch(
        "PRAGMA journal_mode = OFF;
         CREATE TABLE song (
             id       TEXT PRIMARY KEY,
             title    TEXT NOT NULL,
             author   TEXT NOT NULL,
             opening  TEXT NOT NULL,
             terms    TEXT NOT NULL,
             ccli     TEXT NOT NULL,
             sections TEXT NOT NULL,
             vector   BLOB NOT NULL
         );
         -- Exact lookups, for the operator who does remember the title. The
         -- words are not indexed: a search of the whole lyric is the job the
         -- vectors do, and indexing sixteen megabytes of text to do it worse
         -- would double the pack.
         CREATE VIRTUAL TABLE song_fts USING fts5(id UNINDEXED, title, author, opening);",
    )?;

    let mut insert = connection.prepare(
        "INSERT INTO song (id, title, author, opening, terms, ccli, sections, vector)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    let mut index = connection.prepare(
        "INSERT INTO song_fts (id, title, author, opening) VALUES (?1, ?2, ?3, ?4)",
    )?;

    for (song, vector) in songs {
        let opening = opening_line(&song.sections);
        let id = id_for(&song.title, &opening);
        let sections = serde_json::to_string(&song.sections)?;
        insert.execute(rusqlite::params![
            id,
            song.title,
            song.rights.author,
            opening,
            song.rights.terms,
            song.rights.ccli,
            sections,
            pack_vector(vector),
        ])?;
        index.execute(rusqlite::params![id, song.title, song.rights.author, opening])?;
    }

    drop(insert);
    drop(index);
    connection.execute_batch("VACUUM;")?;
    Ok(())
}

/// Half precision back to a float, for reading a pack.
fn from_half(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exponent = ((bits >> 10) & 0x1f) as u32;
    let mantissa = (bits & 0x03ff) as u32;
    match exponent {
        0 if mantissa == 0 => f32::from_bits(sign),
        0 => f32::from_bits(sign | ((mantissa << 13) | 0x3800_0000)),
        0x1f => f32::from_bits(sign | 0x7f80_0000 | (mantissa << 13)),
        _ => f32::from_bits(sign | ((exponent + 112) << 23) | (mantissa << 13)),
    }
}

/**
 * Asking the pack a question, from here.
 *
 * The same two steps a church's machine will take -- embed the words somebody
 * typed, rank every song by cosine -- so the bank can be judged before there
 * is any screen to judge it on. Eleven thousand vectors is four million
 * multiply-adds: the whole catalogue, brute force, in under a millisecond.
 */
fn search(pack: &Path, model: &Path, query: &str) -> Result<()> {
    let embedder = castavox_core::embed::Embedder::load(model)?;
    let asked = embedder.embed_one(query)?;

    let connection = Connection::open(pack)?;
    let mut statement =
        connection.prepare("SELECT title, author, opening, vector FROM song")?;
    let mut scored: Vec<(f32, String, String, String)> = statement
        .query_map([], |row| {
            let bytes: Vec<u8> = row.get(3)?;
            let score = bytes
                .chunks_exact(2)
                .map(|pair| from_half(u16::from_le_bytes([pair[0], pair[1]])))
                .zip(asked.iter())
                .map(|(held, want)| held * want)
                .sum::<f32>();
            Ok((score, row.get(0)?, row.get(1)?, row.get(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!("\n\"{query}\"");
    for (score, title, author, opening) in scored.iter().take(8) {
        let opening: String = opening.chars().take(48).collect();
        println!("  {score:.3}  {title} — {author}   [{opening}]");
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let first = args
        .next()
        .ok_or_else(|| anyhow!("usage: songbank <library.db> <pack.db> [embedder] [keep.txt]\n       songbank --search <pack.db> <embedder> <question>"))?;

    if first == "--search" {
        let pack = PathBuf::from(args.next().unwrap_or_else(|| "songfinder.db".into()));
        let model = PathBuf::from(args.next().unwrap_or_else(|| "resources/embedder".into()));
        let query: Vec<String> = args.collect();
        return search(&pack, &model, &query.join(" "));
    }

    let input = PathBuf::from(first);
    let output = PathBuf::from(args.next().unwrap_or_else(|| "songfinder.db".into()));
    let model = PathBuf::from(
        args.next()
            .unwrap_or_else(|| "resources/embedder".into()),
    );
    let kept_list = PathBuf::from(args.next().unwrap_or_else(|| "keep.txt".into()));

    eprintln!("reading {}", input.display());
    let read = songs_import::from_easyworship(&input)?;
    eprintln!("  {} rows with words in them", read.len());

    /*
     * One song, once.
     *
     * A library built over ten years holds the same song five times: an
     * arrangement, a key change, a capitalisation, a copy somebody made to
     * edit. They are not variants worth offering -- a result list with the
     * same title five times reads as a broken search -- so the longest copy
     * wins, on the grounds that the others are usually truncated.
     */
    let mut best: HashMap<(String, String), Imported> = HashMap::new();
    let mut order: Vec<(String, String)> = Vec::new();
    for song in read {
        let key = (
            normalised(&song.title),
            normalised(&opening_line(&song.sections))
                .chars()
                .take(60)
                .collect(),
        );
        let length: usize = song
            .sections
            .iter()
            .map(|section| section.lines.iter().map(String::len).sum::<usize>())
            .sum();
        match best.get(&key) {
            Some(held)
                if held
                    .sections
                    .iter()
                    .map(|section| section.lines.iter().map(String::len).sum::<usize>())
                    .sum::<usize>()
                    >= length => {}
            Some(_) => {
                best.insert(key, song);
            }
            None => {
                order.push(key.clone());
                best.insert(key, song);
            }
        }
    }
    let all: Vec<Imported> = order
        .into_iter()
        .filter_map(|key| best.remove(&key))
        .collect();
    eprintln!("  {} distinct songs", all.len());

    /*
     * The sieve, and the list of what it caught.
     *
     * Kept by name as well as by the word list, because the word list is a
     * guess and the person building the bank is not: a line in keep.txt naming
     * an author keeps everything of theirs, and a line naming a title keeps
     * that song.
     */
    let keep = read_keep(&kept_list);
    let (songs, left_out): (Vec<Imported>, Vec<Imported>) = all.into_iter().partition(|song| {
        reads_as_worship(song)
            || keep.contains(&keyed(&song.rights.author))
            || keep.contains(&keyed(&song.title))
    });
    let review = output.with_extension("review.txt");
    write_review(&review, &left_out.iter().collect::<Vec<_>>())?;
    eprintln!(
        "  {} kept, {} left out — the list is in {}",
        songs.len(),
        left_out.len(),
        review.display()
    );

    eprintln!("loading the embedder from {}", model.display());
    let embedder = castavox_core::embed::Embedder::load(&model)
        .context("could not load the embedding model")?;

    let mut packed: Vec<(Imported, Vec<f32>)> = Vec::with_capacity(songs.len());
    let total = songs.len();
    for (at, chunk) in songs.chunks(BATCH).enumerate() {
        let texts: Vec<String> = chunk.iter().map(searchable).collect();
        let vectors = embedder.embed(&texts)?;
        for (song, vector) in chunk.iter().cloned().zip(vectors) {
            packed.push((song, vector));
        }
        let done = (at + 1) * BATCH;
        if done % (BATCH * 20) == 0 || done >= total {
            eprintln!("  embedded {}/{}", done.min(total), total);
        }
    }

    write_pack(&output, &packed)?;
    let size = std::fs::metadata(&output)?.len();
    eprintln!(
        "wrote {} — {} songs, {:.1} MB",
        output.display(),
        packed.len(),
        size as f64 / 1e6
    );
    Ok(())
}
