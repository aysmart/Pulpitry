//! The AI Song Finder: describe a song, and get the song.
//!
//! # What it is
//!
//! A catalogue held with the subscription rather than on the machine — titles,
//! authors, the words, and what is known about the rights to them — searched
//! from the song library and added to it one song at a time. It exists because
//! of the shape of a church's first Sunday with new software: the library is
//! empty, the service is at ten, and typing out four songs by hand at nine is
//! how presentation software gets abandoned.
//!
//! # Where the AI is, and where it deliberately is not
//!
//! **In the finding.** The search is by meaning rather than by keyword: the
//! query is embedded and matched against the catalogue, so "the one about
//! waiting on God" finds *Wait On The Lord*, and a half-remembered line finds
//! its song whether or not the words are exact. That is the same retrieval
//! Pulpitry already does against scripture — a paraphrase of a verse finds the
//! verse — pointed at a different corpus. It matters because of how people
//! actually ask for songs: by a line, by what a song is about, by the way the
//! chorus goes. A keyword search answers none of those.
//!
//! # Where the searching happens
//!
//! On the machine. The catalogue is pulled once, after activation, and every
//! search after that is local: the query is embedded by the model Pulpitry
//! already carries and matched against ten thousand vectors, which is four
//! million multiply-adds and takes under a millisecond.
//!
//! The alternative was searching at the broker, and it is worse in every way
//! that matters on a Sunday: a request per query, a model in a serverless
//! function, the words somebody typed leaving the building, and a church whose
//! wifi drops losing the feature in the middle of a set. Pulling it once buys
//! all of that back, and the catalogue is the church's to search offline for
//! as long as they have it.
//!
//! **Not in the words.** Nothing here is generated. Every song is a real
//! entry in a catalogue somebody assembled from libraries churches already own,
//! carrying its own rights, and a song whose terms nobody has checked says so.
//! An invented lyric on a wall is the failure this product cannot have — a
//! congregation singing a line the songwriter never wrote, in a service, with
//! our name on the screen. So the model chooses *which song*, never *what it
//! says*.
//!
//! # Why it is not scraped
//!
//! It would have been easy to point this at a lyrics site and it is not what
//! this is. The catalogue is assembled from libraries a church already owns and
//! exports — EasyWorship, ProPresenter — and every song carries its rights as
//! stated, including the ones that say nobody has checked. A song whose terms
//! are unknown arrives saying so, and the operator sees that before it goes on
//! a wall. What Pulpitry never does is claim a licence on a church's behalf:
//! CCLI is a licence they hold and report against, and the number field is
//! theirs to fill.
//!
//! # Why the subscription gates it
//!
//! Everything Pulpitry does on the machine is free and unlimited, and that is
//! deliberate. This is the one part that is not on the machine: it is a
//! catalogue somebody assembles, checks and hosts, and it costs something to
//! keep. The gate is the broker's, not this file's — the endpoint refuses an
//! unactivated machine — and what is here is only the courtesy of saying so
//! before the request is made.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::catalog::{Item, ItemBody, SongRights, SongSection};
use crate::hosted::broker_base;
use crate::settings;

/// How long a search may take before it is a failure rather than a wait.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// One song as a list of results shows it.
///
/// Deliberately not the words. A search returns forty of these and nobody reads
/// forty songs; the words are fetched for the one that is opened, which keeps
/// the list quick and means the catalogue is not handed over wholesale to
/// anything that can type a letter into a box.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// The first line, which is how half of a congregation names a song.
    #[serde(default)]
    pub opening: String,
    /// "unknown", "publicDomain", "licensed", "restricted" — as stored.
    #[serde(default)]
    pub rights: String,
    /// How many parts it has, so a two-line chorus is not mistaken for a hymn.
    #[serde(default)]
    pub sections: i64,
}

/// A whole song, in exactly the shape the library stores one.
///
/// The same `SongSection` and `SongRights` the catalogue uses, so adding one is
/// a save rather than a conversion — and so a song that came from the AI Song Finder
/// is indistinguishable afterwards from one the church typed themselves. It is
/// theirs once it is added: editable, exportable, and unaffected by anything
/// that happens to the subscription.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub author: String,
    pub sections: Vec<SongSection>,
    #[serde(default)]
    pub rights: SongRights,
}

/// What this machine holds of the catalogue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether it can be searched now, with or without a network.
    pub ready: bool,
    /// The bank this copy came from, so a newer one can be offered.
    pub version: String,
    pub songs: i64,
}

/// What the broker is serving, without pulling any of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub songs: i64,
}

/// One page of the catalogue, as the broker hands it over.
#[derive(Debug, Deserialize)]
struct Page {
    #[serde(default)]
    version: String,
    #[serde(default)]
    songs: i64,
    #[serde(default)]
    next: String,
    #[serde(default)]
    page: Vec<Row>,
}

#[derive(Debug, Deserialize)]
struct Row {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    opening: String,
    #[serde(default)]
    terms: String,
    #[serde(default)]
    ccli: String,
    /// The parts, as JSON, carried as text because this side stores a song and
    /// never reads one until it is asked for.
    #[serde(default)]
    sections: String,
    /// Half-precision floats, base64: JSON has no way to carry bytes.
    #[serde(default)]
    vector: String,
}

/// Where the catalogue lives on this machine.
///
/// Beside the church's own library rather than inside it. The bank is not
/// theirs -- adding a song copies it across, and that copy is -- so a rebuilt
/// bank is a file swapped rather than a merge into everything they have made.
pub fn pack_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| anyhow!("could not find the application folder: {err}"))?;
    std::fs::create_dir_all(&dir).ok();
    Ok(dir.join("songfinder.db"))
}

fn open_pack(app: &tauri::AppHandle) -> Result<rusqlite::Connection> {
    let path = pack_path(app)?;
    if !path.exists() {
        return Err(anyhow!(
            "The Song Finder catalogue has not been downloaded on this machine yet."
        ));
    }
    rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("could not open {}", path.display()))
}

/// What is held, asked of the file rather than remembered.
pub fn status(app: &tauri::AppHandle) -> Status {
    let empty = Status { ready: false, version: String::new(), songs: 0 };
    let Ok(connection) = open_pack(app) else { return empty };
    let read: rusqlite::Result<(String, i64)> = connection.query_row(
        "SELECT version, songs FROM bank WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    match read {
        Ok((version, songs)) if songs > 0 => Status { ready: true, version, songs },
        _ => empty,
    }
}

/// Base64 back to the bytes it was made from.
///
/// By hand for the same reason the percent-encoder is: sixteen lines against a
/// dependency to audit, and the only input it will ever see is a vector this
/// project encoded.
fn unbase64(text: &str) -> Vec<u8> {
    let value = |byte: u8| -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a') as u32 + 26,
            b'0'..=b'9' => (byte - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        })
    };

    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut block = 0u32;
    let mut held = 0u32;
    for byte in text.bytes() {
        let Some(six) = value(byte) else { continue };
        block = (block << 6) | six;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push(((block >> held) & 0xff) as u8);
        }
    }
    out
}

/// Half precision back to a float.
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

/// The schema of the pack, which is the pack builder's schema.
const PACK: &str = "CREATE TABLE song (
        id       TEXT PRIMARY KEY,
        title    TEXT NOT NULL,
        author   TEXT NOT NULL,
        opening  TEXT NOT NULL,
        terms    TEXT NOT NULL,
        ccli     TEXT NOT NULL,
        sections TEXT NOT NULL,
        vector   BLOB NOT NULL
     );
     CREATE TABLE bank (id INTEGER PRIMARY KEY, version TEXT NOT NULL, songs INTEGER NOT NULL);";

/**
 * Pulls the catalogue down, a page at a time.
 *
 * Written to a file beside the real one and moved over it at the end, so a
 * pull that is interrupted -- a closed laptop, a dropped connection, a service
 * starting -- leaves the catalogue that was already there rather than half of
 * a new one that looks complete.
 *
 * Progress is emitted as it goes: fourteen megabytes on church wifi is a
 * minute or two, and a button that does nothing visible for two minutes is a
 * button somebody presses again.
 */
/**
 * Which catalogue the broker has, so a newer one can be offered.
 *
 * # Why this asks for a song it throws away
 *
 * Every page of the pack carries the bank's version and its total, so one
 * page of one song answers the question. A route of its own would be a
 * second thing to keep in step with the first, for a reply that is already
 * being sent.
 *
 * The cost is about a kilobyte: a title, a few words and one song's vector.
 * That is cheaper than the question being skipped, which is what happened
 * before this existed -- a church that pulled the catalogue once kept
 * whatever it got, and the bank growing from ten thousand songs to
 * twenty-four did not reach a single machine that already had it.
 */
pub fn latest() -> Result<Available> {
    let token = credential()?;
    let client = castavox_core::tls::client()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("could not start a secure connection")?;

    let response = client
        .get(format!("{}/api/v1/songfinder/pack?limit=1", broker_base()))
        .bearer_auth(&token)
        .send()
        .context("could not reach the Song Finder")?;

    let code = response.status();
    if code == reqwest::StatusCode::UNAUTHORIZED || code == reqwest::StatusCode::FORBIDDEN {
        return Err(anyhow!(
            "This subscription does not include the Song Finder, or it has ended. Settings → Subscription."
        ));
    }
    if !code.is_success() {
        return Err(anyhow!("The Song Finder is not answering just now ({code})."));
    }

    let page: Page = response
        .json()
        .context("the Song Finder sent something unreadable")?;

    /*
     * Logged, because "my Song Finder never grew" is otherwise unanswerable.
     *
     * The check is quiet by design -- a failure says nothing to the operator,
     * since what is on the machine still works -- and quiet failures are the
     * ones that go unreported for a season. A line here is the difference
     * between a support question with an answer and one without.
     */
    crate::log::line(&format!(
        "[songfinder] the catalogue on offer is {} ({} songs)",
        page.version, page.songs
    ));
    Ok(Available { version: page.version, songs: page.songs })
}

pub fn pull(app: &tauri::AppHandle) -> Result<Status> {
    use tauri::Emitter;

    let token = credential()?;
    let client = castavox_core::tls::client()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("could not start a secure connection")?;

    let path = pack_path(app)?;
    let building = path.with_extension("part");
    let _ = std::fs::remove_file(&building);
    let connection = rusqlite::Connection::open(&building)?;
    connection.execute_batch(&format!("PRAGMA journal_mode = OFF; {PACK}"))?;

    let mut after = String::new();
    let mut held = 0i64;
    let mut version = String::new();
    let mut expected = 0i64;

    loop {
        let response = client
            .get(format!(
                "{}/api/v1/songfinder/pack?limit=200&after={}",
                broker_base(),
                urlencode(&after)
            ))
            .bearer_auth(&token)
            .send()
            .context("could not reach the Song Finder")?;

        let code = response.status();
        if code == reqwest::StatusCode::UNAUTHORIZED || code == reqwest::StatusCode::FORBIDDEN {
            return Err(anyhow!(
                "This subscription does not include the Song Finder, or it has ended. Settings → Subscription."
            ));
        }
        if !code.is_success() {
            return Err(anyhow!("The Song Finder is not answering just now ({code})."));
        }

        let page: Page = response
            .json()
            .context("the Song Finder sent something unreadable")?;
        version = page.version.clone();
        expected = page.songs;

        {
            let batch = connection.unchecked_transaction()?;
            let mut insert = connection.prepare_cached(
                "INSERT OR REPLACE INTO song (id, title, author, opening, terms, ccli, sections, vector)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for row in &page.page {
                insert.execute(rusqlite::params![
                    row.id,
                    row.title,
                    row.author,
                    row.opening,
                    row.terms,
                    row.ccli,
                    row.sections,
                    unbase64(&row.vector),
                ])?;
            }
            drop(insert);
            batch.commit()?;
        }

        held += page.page.len() as i64;
        let _ = app.emit("songfinder:pull", (held, expected.max(held)));

        if page.next.is_empty() || page.page.is_empty() {
            break;
        }
        after = page.next;
    }

    connection.execute(
        "INSERT OR REPLACE INTO bank (id, version, songs) VALUES (1, ?1, ?2)",
        rusqlite::params![version, held],
    )?;
    drop(connection);

    std::fs::rename(&building, &path)
        .with_context(|| format!("could not put the catalogue in place at {}", path.display()))?;

    Ok(status(app))
}

/// The token this machine was activated with, or a refusal naming the fix.
fn credential() -> Result<String> {
    settings::load_hosted_token()?.ok_or_else(|| {
        anyhow!("The AI Song Finder comes with a Castavox subscription. Settings → Subscription to activate one.")
    })
}

/**
 * Searching the catalogue, on this machine.
 *
 * Two passes and both are cheap. The first scores every song by the cosine of
 * its vector against the query's -- ten thousand of them is four million
 * multiply-adds, under a millisecond -- and the second reads the words of the
 * handful that won, because counting the parts of ten thousand songs to
 * answer a question about forty would be the expensive half.
 *
 * A title that contains what was typed is lifted, because somebody who types
 * "how great thou art" has not described a song, they have named it, and
 * meaning alone would rank a dozen songs about greatness alongside it.
 */
pub fn search(
    app: &tauri::AppHandle,
    semantic: &crate::semantic::Semantic,
    query: &str,
    limit: usize,
) -> Result<Vec<Hit>> {
    let asked = query.trim();
    if asked.is_empty() {
        return Ok(Vec::new());
    }

    let connection = open_pack(app)?;
    let wanted = semantic
        .embed_texts(&[asked.to_string()])?
        .pop()
        .ok_or_else(|| anyhow!("the query could not be read"))?;
    let needle = asked.to_lowercase();

    let mut statement = connection.prepare("SELECT id, title, vector FROM song")?;
    let mut scored: Vec<(f32, String)> = statement
        .query_map([], |row| {
            let title: String = row.get(1)?;
            let bytes: Vec<u8> = row.get(2)?;
            let mut score: f32 = bytes
                .chunks_exact(2)
                .map(|pair| from_half(u16::from_le_bytes([pair[0], pair[1]])))
                .zip(wanted.iter())
                .map(|(held, want)| held * want)
                .sum();
            if title.to_lowercase().contains(&needle) {
                score += 0.25;
            }
            Ok((score, row.get(0)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.truncate(limit.clamp(1, 100));

    let mut hits = Vec::with_capacity(scored.len());
    let mut one = connection
        .prepare("SELECT title, author, opening, sections FROM song WHERE id = ?1")?;
    for (_, id) in scored {
        let found = one.query_row([&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        });
        if let Ok((title, author, opening, sections)) = found {
            let parts: Vec<SongSection> = serde_json::from_str(&sections).unwrap_or_default();
            hits.push(Hit {
                id,
                title,
                author,
                opening,
                // Everything in the bank arrives with its terms unchecked, and
                // says so rather than looking cleared. See `SongRights`.
                rights: "unknown".to_string(),
                sections: parts.len() as i64,
            });
        }
    }

    Ok(hits)
}

/// One song, with its words, from the pack.
pub fn song(app: &tauri::AppHandle, id: &str) -> Result<Song> {
    let id = id.trim();
    if id.is_empty() {
        return Err(anyhow!("No song was asked for."));
    }

    let connection = open_pack(app)?;
    let found = connection
        .query_row(
            "SELECT title, author, terms, ccli, sections FROM song WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(|_| anyhow!("That song is not in this copy of the catalogue."))?;

    let (title, author, terms, ccli, sections) = found;
    Ok(Song {
        id: id.to_string(),
        title,
        author: author.clone(),
        sections: serde_json::from_str(&sections).unwrap_or_default(),
        rights: SongRights {
            status: crate::catalog::RightsStatus::Unknown,
            author,
            composer: String::new(),
            terms,
            source: "Pulpitry Song Finder".to_string(),
            ccli,
        },
    })
}

/// What a song looks like once it is the church's own.
///
/// The provenance is kept in `source` rather than in a field of its own: it is
/// part of the answer to "where did these words come from and on what terms",
/// which is the question `SongRights` exists to make unavoidable.
pub fn as_item(song: &Song) -> Item {
    let mut rights = song.rights.clone();
    if rights.source.trim().is_empty() {
        rights.source = "Pulpitry Song Finder".to_string();
    }

    Item {
        id: None,
        title: song.title.clone(),
        subtitle: song.author.clone(),
        body: ItemBody::Song {
            sections: song.sections.clone(),
            rights,
        },
        path: None,
        updated_at: 0,
    }
}

/// Percent-encodes a query for a URL.
///
/// By hand, because the only characters that matter here are the ones a song
/// title actually contains — spaces, apostrophes, commas, the odd ampersand —
/// and a dependency for that would be a dependency to audit.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_survives_being_put_in_a_url() {
        assert_eq!(urlencode("Waymaker"), "Waymaker");
        assert_eq!(urlencode("Great Is Thy Faithfulness"), "Great%20Is%20Thy%20Faithfulness");
        // The characters a song title genuinely has in it.
        assert_eq!(urlencode("It's Well & Good"), "It%27s%20Well%20%26%20Good");
        // Yoruba, which the catalogue is full of and which is why this is not
        // an ASCII-only escape.
        assert_eq!(urlencode("Olúwa"), "Ol%C3%BAwa");
    }

    #[test]
    fn a_vector_survives_the_journey_from_the_broker() {
        /*
         * Base64 and half precision, which is how a vector crosses JSON.
         *
         * Worth a test because getting either wrong is silent: the numbers
         * still arrive, the search still answers, and every answer is quietly
         * the wrong song. A ruined decoder does not look like a fault, it
         * looks like a bad catalogue.
         */
        let wanted: Vec<f32> = vec![0.0, 1.0, -1.0, 0.5, -0.25, 0.0625, 0.333_25];
        // As the pack builder writes them: half precision, little-endian.
        let halved: Vec<u8> = wanted
            .iter()
            .flat_map(|value| {
                let bits = value.to_bits();
                let sign = ((bits >> 16) & 0x8000) as u16;
                let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
                let mantissa = bits & 0x007f_ffff;
                let half = if exponent <= 0 {
                    sign
                } else if exponent >= 0x1f {
                    sign | 0x7c00
                } else {
                    sign | ((exponent as u16) << 10) | ((mantissa >> 13) as u16)
                };
                half.to_le_bytes()
            })
            .collect();

        const B64: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut encoded = String::new();
        for chunk in halved.chunks(3) {
            let (a, b, c) = (
                chunk[0] as u32,
                *chunk.get(1).unwrap_or(&0) as u32,
                *chunk.get(2).unwrap_or(&0) as u32,
            );
            let block = (a << 16) | (b << 8) | c;
            for shift in [18, 12, 6, 0] {
                encoded.push(B64[((block >> shift) & 0x3f) as usize] as char);
            }
            let padding = 3 - chunk.len();
            encoded.truncate(encoded.len() - padding);
            encoded.push_str(&"=".repeat(padding));
        }

        let back: Vec<f32> = unbase64(&encoded)
            .chunks_exact(2)
            .map(|pair| from_half(u16::from_le_bytes([pair[0], pair[1]])))
            .collect();

        assert_eq!(back.len(), wanted.len(), "a vector changed length");
        for (was, now) in wanted.iter().zip(back.iter()) {
            assert!(
                (was - now).abs() < 0.001,
                "{was} came back as {now}",
            );
        }
    }

    #[test]
    fn a_song_becomes_an_ordinary_library_item() {
        let song = Song {
            id: "sb-1".into(),
            title: "Wait On The Lord".into(),
            author: "Elevation Worship".into(),
            sections: vec![SongSection {
                label: "Verse 1".into(),
                lines: vec!["Wait on the Lord".into()],
                components: None,
                layout: None,
                elements: None,
            }],
            rights: SongRights::default(),
        };

        let item = as_item(&song);
        assert_eq!(item.title, "Wait On The Lord");
        assert_eq!(item.subtitle, "Elevation Worship");
        assert!(item.id.is_none(), "it is a new row in this church's library");

        let ItemBody::Song { sections, rights } = item.body else {
            panic!("a song should arrive as a song");
        };
        assert_eq!(sections.len(), 1);
        // Where the words came from, so the rights claim can be traced.
        assert_eq!(rights.source, "Pulpitry Song Finder");
    }
}
