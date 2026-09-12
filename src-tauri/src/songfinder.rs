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

#[derive(Debug, Deserialize)]
struct Results {
    #[serde(default)]
    hits: Vec<Hit>,
}

/// The token this machine was activated with, or a refusal naming the fix.
fn credential() -> Result<String> {
    settings::load_hosted_token()?.ok_or_else(|| {
        anyhow!("The AI Song Finder comes with a Castavox subscription. Settings → Subscription to activate one.")
    })
}

fn get<T: serde::de::DeserializeOwned>(path: &str) -> Result<T> {
    let token = credential()?;
    let response = castavox_core::tls::client()
        .timeout(TIMEOUT)
        // Not followed: across hosts it would drop the credential and return a
        // refusal that blames the subscription. The broker's own client makes
        // the same choice for the same reason.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("could not start a secure connection")?
        .get(format!("{}/api/v1/songfinder/{path}", broker_base()))
        .bearer_auth(token)
        .send()
        .context("could not reach the AI Song Finder")?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(anyhow!("That song is no longer in the AI Song Finder."));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(anyhow!(
            "This subscription does not include the AI Song Finder, or it has ended. Settings → Subscription."
        ));
    }
    if !status.is_success() {
        return Err(anyhow!("The AI Song Finder is not answering just now ({status})."));
    }

    response.json::<T>().context("the AI Song Finder sent something unreadable")
}

/// Searches by title, author or a line of the words.
pub fn search(query: &str, limit: usize) -> Result<Vec<Hit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let encoded = urlencode(query);
    let limit = limit.clamp(1, 100);
    let found: Results = get(&format!("search?q={encoded}&limit={limit}"))?;
    Ok(found.hits)
}

/// One song, with its words.
pub fn song(id: &str) -> Result<Song> {
    if id.trim().is_empty() {
        return Err(anyhow!("No song was asked for."));
    }
    get(&format!("songs/{}", urlencode(id.trim())))
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
    fn an_empty_search_asks_nothing_of_the_network() {
        // No subscription is needed to not search: an empty box is not a
        // question, and a refusal about the subscription there would be a
        // message about the wrong thing.
        assert!(matches!(search("   ", 20), Ok(hits) if hits.is_empty()));
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
