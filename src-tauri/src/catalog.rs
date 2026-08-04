//! The operator's library: songs, images, media, templates and slides.
//!
//! Named `Catalog` in code only to avoid colliding with [`crate::bible::Library`],
//! which holds scripture. To the operator this is "the library".
//!
//! One table rather than five. The things a service needs to keep are more
//! alike than not — each has a title, needs finding by name, and wants to be
//! listed most-recent-first — and the parts that genuinely differ live in a
//! typed body. Five parallel tables would mean five search implementations and
//! five list queries that drift apart.
//!
//! It shares the database file with the verse library but holds its own
//! connection, so neither module reaches into the other's internals. SQLite in
//! WAL mode is happy with that.

use std::path::Path;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::projector::TextBlock;
use crate::settings::ProjectorTheme;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS catalog_items (
    id         INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    subtitle   TEXT    NOT NULL DEFAULT '',
    body       TEXT    NOT NULL,
    path       TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_kind
    ON catalog_items(kind, updated_at DESC);

-- Standalone rather than external-content: unlike verses, these rows are
-- edited, and keeping a separate index the repository writes to is easier to
-- reason about than triggers firing on every save.
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
    text,
    tokenize='porter unicode61'
);
"#;

/// A labelled block of a song: "Verse 1", "Chorus", "Bridge".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongSection {
    pub label: String,
    /// Kept as written. A lyric breaks where the writer broke it.
    pub lines: Vec<String>,
}

/// What one line of a service plan points at.
///
/// References, never resolved content. A plan is written days before it is
/// run and kept for years afterwards, so it has to survive the song being
/// retitled and the verse library being reimported underneath it.
// `rename_all` on an enum renames the variants, not the fields inside them —
// `rename_all_fields` is what makes `book_number` arrive as `bookNumber`.
// Without it a plan holding a passage fails to deserialize and the whole save
// is rejected, which looks exactly like the schedule quietly not persisting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PlanBody {
    /// A passage held as book/chapter/verse rather than row ids, which are an
    /// import detail and not stable across one.
    Scripture {
        translation: String,
        book_number: i64,
        chapter: i64,
        verse: i64,
        /// Equal to `verse` for a single verse.
        end_verse: i64,
    },
    /// Anything else in this catalog — a song today, an image or a slide once
    /// those have libraries. The kind is read from the item itself.
    Item { item_id: i64 },
    /// A heading with nothing behind it: "Welcome", "Offering", "Sermon".
    /// A running order is mostly not projected, and a plan that could only
    /// hold projectable things would not be the service.
    Note,
}

/// One line of a service plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    /// What to show before anything has been looked up, and what makes a
    /// service findable by what was in it. Refreshed from the item whenever
    /// one is resolved, so a retitled song corrects itself.
    pub label: String,
    pub body: PlanBody,
}

/// The part of an item that differs by kind.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ItemBody {
    Song { sections: Vec<SongSection> },
    /// Images carry nothing beyond the file path on the item itself.
    Image,
    Media { looping: bool },
    Template { theme: Box<ProjectorTheme> },
    Slide { blocks: Vec<TextBlock> },
    /// A service plan: the running order for one gathering.
    Service { entries: Vec<PlanEntry> },
}

impl ItemBody {
    /// Kept in a column of its own so listing one kind stays an index lookup.
    pub fn kind(&self) -> &'static str {
        match self {
            ItemBody::Song { .. } => "song",
            ItemBody::Image => "image",
            ItemBody::Media { .. } => "media",
            ItemBody::Template { .. } => "template",
            ItemBody::Slide { .. } => "slide",
            ItemBody::Service { .. } => "service",
        }
    }

    /// The words worth finding this item by.
    ///
    /// Lyrics matter here: an operator half-remembers a line far more often
    /// than they remember a song's exact title.
    fn searchable(&self) -> String {
        match self {
            ItemBody::Song { sections } => sections
                .iter()
                .flat_map(|section| section.lines.iter().cloned())
                .collect::<Vec<_>>()
                .join(" "),
            ItemBody::Slide { blocks } => blocks
                .iter()
                .map(|block| block.text.clone())
                .collect::<Vec<_>>()
                .join(" "),
            // An operator looking for an old service remembers what was in it
            // — a song, a passage — far sooner than what it was called.
            ItemBody::Service { entries } => entries
                .iter()
                .map(|entry| entry.label.clone())
                .collect::<Vec<_>>()
                .join(" "),
            ItemBody::Image | ItemBody::Media { .. } | ItemBody::Template { .. } => String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Absent when saving something new.
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    pub body: ItemBody,
    /// External file, for images and media.
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
}

pub struct Catalog {
    connection: Mutex<Connection>,
}

impl Catalog {
    pub fn open(directory: &Path) -> Result<Self> {
        let connection = Connection::open(directory.join("pulpitry.db"))
            .context("could not open the library")?;
        connection.execute_batch(SCHEMA).context("could not prepare the library")?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    /// Inserts a new item, or updates the one whose id is set.
    pub fn save(&self, item: &Item) -> Result<Item> {
        let body = serde_json::to_string(&item.body)?;
        let searchable = format!(
            "{} {} {}",
            item.title,
            item.subtitle,
            item.body.searchable()
        );
        let now = now_millis();

        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;

        let id = match item.id {
            Some(id) => {
                transaction.execute(
                    "UPDATE catalog_items
                     SET kind = ?2, title = ?3, subtitle = ?4, body = ?5, path = ?6,
                         updated_at = ?7
                     WHERE id = ?1",
                    params![id, item.body.kind(), item.title, item.subtitle, body, item.path, now],
                )?;
                id
            }
            None => {
                transaction.execute(
                    "INSERT INTO catalog_items(kind, title, subtitle, body, path, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![item.body.kind(), item.title, item.subtitle, body, item.path, now],
                )?;
                transaction.last_insert_rowid()
            }
        };

        // The index row is replaced wholesale; an edited title must not remain
        // findable under its old wording.
        transaction.execute("DELETE FROM catalog_fts WHERE rowid = ?1", params![id])?;
        transaction.execute(
            "INSERT INTO catalog_fts(rowid, text) VALUES (?1, ?2)",
            params![id, searchable],
        )?;
        transaction.commit()?;

        Ok(Item { id: Some(id), updated_at: now, ..item.clone() })
    }

    pub fn remove(&self, id: i64) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM catalog_items WHERE id = ?1", params![id])?;
        transaction.execute("DELETE FROM catalog_fts WHERE rowid = ?1", params![id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get(&self, id: i64) -> Result<Option<Item>> {
        let connection = self.connection.lock();
        Ok(connection
            .query_row(
                "SELECT id, title, subtitle, body, path, updated_at FROM catalog_items
                 WHERE id = ?1",
                params![id],
                read_item,
            )
            .optional()?
            .transpose()?)
    }

    /// Most recently touched first, which is what an operator reaches for.
    pub fn list(&self, kind: &str, limit: i64) -> Result<Vec<Item>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, title, subtitle, body, path, updated_at FROM catalog_items
             WHERE kind = ?1
             ORDER BY updated_at DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![kind, limit.clamp(1, 1000)], read_item)?;
        collect(rows)
    }

    /// Every external file the library points at.
    ///
    /// The webview can read no arbitrary path, so each of these has to be
    /// granted individually at startup or an image imported last week would
    /// come back as a broken frame.
    pub fn media_paths(&self) -> Result<Vec<String>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT path FROM catalog_items
             WHERE path IS NOT NULL AND kind IN ('image', 'media')",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut paths = Vec::new();
        for row in rows {
            paths.push(row?);
        }
        Ok(paths)
    }

    /// Full-text search, optionally within one kind.
    pub fn search(&self, query: &str, kind: Option<&str>, limit: i64) -> Result<Vec<Item>> {
        let Some(expression) = fts_query(query) else { return self.list(kind.unwrap_or("song"), limit) };

        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT i.id, i.title, i.subtitle, i.body, i.path, i.updated_at
             FROM catalog_fts f
             JOIN catalog_items i ON i.id = f.rowid
             WHERE catalog_fts MATCH ?1 AND (?2 IS NULL OR i.kind = ?2)
             ORDER BY bm25(catalog_fts)
             LIMIT ?3",
        )?;
        let rows = statement.query_map(params![expression, kind, limit.clamp(1, 500)], read_item)?;
        collect(rows)
    }
}

type Row = rusqlite::Result<Result<Item>>;

fn collect(rows: impl Iterator<Item = Row>) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    for row in rows {
        items.push(row??);
    }
    Ok(items)
}

fn read_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<Item>> {
    let raw: String = row.get(3)?;
    let id: i64 = row.get(0)?;
    let title: String = row.get(1)?;
    let subtitle: String = row.get(2)?;
    let path: Option<String> = row.get(4)?;
    let updated_at: i64 = row.get(5)?;

    Ok(serde_json::from_str::<ItemBody>(&raw)
        .with_context(|| format!("library item {id} has a malformed body"))
        .map(|body| Item { id: Some(id), title, subtitle, body, path, updated_at }))
}

/// Quotes every term, which both escapes FTS5's operators and gives an
/// implicit AND across them.
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

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(title: &str, lines: &[&str]) -> Item {
        Item {
            id: None,
            title: title.into(),
            subtitle: "John Newton".into(),
            body: ItemBody::Song {
                sections: vec![SongSection {
                    label: "Verse 1".into(),
                    lines: lines.iter().map(|line| line.to_string()).collect(),
                }],
            },
            path: None,
            updated_at: 0,
        }
    }

    #[test]
    fn saving_assigns_an_id_and_returns_the_stored_item() {
        let catalog = Catalog::in_memory().expect("catalog");
        let saved = catalog.save(&song("Amazing Grace", &["Amazing grace how sweet the sound"]))
            .expect("save");

        assert!(saved.id.is_some());
        assert!(saved.updated_at > 0);
        assert_eq!(catalog.get(saved.id.unwrap()).expect("get"), Some(saved));
    }

    #[test]
    fn saving_with_an_id_updates_rather_than_duplicating() {
        let catalog = Catalog::in_memory().expect("catalog");
        let mut saved = catalog.save(&song("Amazing Grace", &["how sweet"])).expect("save");

        saved.title = "Amazing Grace (Newton)".into();
        catalog.save(&saved).expect("update");

        let all = catalog.list("song", 10).expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "Amazing Grace (Newton)");
    }

    #[test]
    fn every_body_kind_round_trips() {
        let catalog = Catalog::in_memory().expect("catalog");
        let bodies = vec![
            ItemBody::Song { sections: vec![SongSection { label: "Chorus".into(), lines: vec!["x".into()] }] },
            ItemBody::Image,
            ItemBody::Media { looping: true },
            ItemBody::Template { theme: Box::new(ProjectorTheme::default()) },
            ItemBody::Slide {
                blocks: vec![TextBlock {
                    text: "Welcome".into(),
                    level: "heading".into(),
                    align: "center".into(),
                    bold: true,
                    italic: false,
                }],
            },
            ItemBody::Service {
                entries: vec![
                    PlanEntry { label: "Welcome".into(), body: PlanBody::Note },
                    PlanEntry { label: "Amazing Grace".into(), body: PlanBody::Item { item_id: 7 } },
                    PlanEntry {
                        label: "John 3:16-18".into(),
                        body: PlanBody::Scripture {
                            translation: "KJV".into(),
                            book_number: 43,
                            chapter: 3,
                            verse: 16,
                            end_verse: 18,
                        },
                    },
                ],
            },
        ];

        for body in bodies {
            let kind = body.kind().to_string();
            let saved = catalog
                .save(&Item {
                    id: None,
                    title: format!("a {kind}"),
                    subtitle: String::new(),
                    body: body.clone(),
                    path: None,
                    updated_at: 0,
                })
                .expect("save");
            assert_eq!(catalog.get(saved.id.unwrap()).expect("get").unwrap().body, body);
            assert_eq!(catalog.list(&kind, 10).expect("list").len(), 1);
        }
    }

    #[test]
    fn search_finds_a_song_by_a_half_remembered_line() {
        // Operators reach for a lyric far more often than an exact title.
        let catalog = Catalog::in_memory().expect("catalog");
        catalog.save(&song("Amazing Grace", &["Amazing grace how sweet the sound"])).expect("save");
        catalog.save(&song("Be Thou My Vision", &["Be thou my vision O Lord of my heart"])).expect("save");

        let found = catalog.search("sweet sound", None, 10).expect("search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Amazing Grace");
    }

    #[test]
    fn search_can_be_confined_to_one_kind() {
        let catalog = Catalog::in_memory().expect("catalog");
        catalog.save(&song("Grace", &["grace"])).expect("save");
        catalog
            .save(&Item {
                id: None,
                title: "Grace".into(),
                subtitle: String::new(),
                body: ItemBody::Slide { blocks: Vec::new() },
                path: None,
                updated_at: 0,
            })
            .expect("save");

        assert_eq!(catalog.search("grace", None, 10).expect("search").len(), 2);
        assert_eq!(catalog.search("grace", Some("slide"), 10).expect("search").len(), 1);
    }

    #[test]
    fn an_edited_title_is_no_longer_findable_under_the_old_one() {
        let catalog = Catalog::in_memory().expect("catalog");
        let mut saved = catalog.save(&song("Hosanna", &["la"])).expect("save");

        saved.title = "Blessed Assurance".into();
        catalog.save(&saved).expect("update");

        assert!(catalog.search("hosanna", None, 10).expect("search").is_empty());
        assert_eq!(catalog.search("blessed", None, 10).expect("search").len(), 1);
    }

    #[test]
    fn removing_takes_it_out_of_search_too() {
        let catalog = Catalog::in_memory().expect("catalog");
        let saved = catalog.save(&song("Hosanna", &["la"])).expect("save");

        catalog.remove(saved.id.unwrap()).expect("remove");

        assert!(catalog.get(saved.id.unwrap()).expect("get").is_none());
        assert!(catalog.search("hosanna", None, 10).expect("search").is_empty());
    }

    #[test]
    fn listing_puts_the_most_recently_touched_first() {
        let catalog = Catalog::in_memory().expect("catalog");
        let first = catalog.save(&song("First", &["a"])).expect("save");
        catalog.save(&song("Second", &["b"])).expect("save");

        // Touching the older one should float it back to the top.
        std::thread::sleep(std::time::Duration::from_millis(2));
        catalog.save(&first).expect("update");

        let listed = catalog.list("song", 10).expect("list");
        assert_eq!(listed[0].title, "First");
    }

    #[test]
    fn a_service_is_findable_by_what_was_in_it() {
        // Nobody remembers that last Easter's plan was called "Service 3".
        let catalog = Catalog::in_memory().expect("catalog");
        catalog
            .save(&Item {
                id: None,
                title: "Sunday 4 May".into(),
                subtitle: String::new(),
                body: ItemBody::Service {
                    entries: vec![
                        PlanEntry { label: "Welcome".into(), body: PlanBody::Note },
                        PlanEntry {
                            label: "Be Thou My Vision".into(),
                            body: PlanBody::Item { item_id: 4 },
                        },
                    ],
                },
                path: None,
                updated_at: 0,
            })
            .expect("save");

        let found = catalog.search("vision", Some("service"), 10).expect("search");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Sunday 4 May");
    }

    #[test]
    fn a_plan_parses_the_json_the_operator_window_actually_sends() {
        // Round-tripping through our own serde proves nothing about this: both
        // ends would agree on snake_case and the UI would still be rejected.
        // These are the exact payloads the TypeScript builds.
        let scripture = r#"{"kind":"scripture","translation":"KJV","bookNumber":43,
            "chapter":3,"verse":16,"endVerse":18}"#;
        assert_eq!(
            serde_json::from_str::<PlanBody>(scripture).expect("scripture entry"),
            PlanBody::Scripture {
                translation: "KJV".into(),
                book_number: 43,
                chapter: 3,
                verse: 16,
                end_verse: 18,
            }
        );

        let item = r#"{"kind":"item","itemId":7}"#;
        assert_eq!(
            serde_json::from_str::<PlanBody>(item).expect("item entry"),
            PlanBody::Item { item_id: 7 }
        );

        assert_eq!(
            serde_json::from_str::<PlanBody>(r#"{"kind":"note"}"#).expect("note entry"),
            PlanBody::Note
        );

        // And the whole item, as catalog_save receives it.
        let saved = r#"{"id":null,"title":"Sunday Morning","subtitle":"","path":null,
            "updatedAt":0,"body":{"kind":"service","entries":[
              {"label":"Welcome","body":{"kind":"note"}},
              {"label":"John 3:16","body":{"kind":"scripture","translation":"KJV",
                "bookNumber":43,"chapter":3,"verse":16,"endVerse":16}}]}}"#;
        let parsed: Item = serde_json::from_str(saved).expect("a whole service");
        let ItemBody::Service { entries } = parsed.body else { panic!("expected a service") };
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn what_we_serialise_is_what_we_can_read_back() {
        // The stored column and the wire format are the same bytes, so a
        // rename that broke one would break the other.
        let body = PlanBody::Scripture {
            translation: "KJV".into(),
            book_number: 43,
            chapter: 3,
            verse: 16,
            end_verse: 18,
        };
        let json = serde_json::to_string(&body).expect("serialise");
        assert!(json.contains("\"bookNumber\""), "wire format drifted: {json}");
        assert_eq!(serde_json::from_str::<PlanBody>(&json).expect("read back"), body);
    }

    #[test]
    fn a_plan_keeps_references_rather_than_resolved_verses() {
        // The whole point of storing book/chapter/verse: reimporting the verse
        // library must not silently repoint a saved plan at other verses.
        let catalog = Catalog::in_memory().expect("catalog");
        let saved = catalog
            .save(&Item {
                id: None,
                title: "Easter".into(),
                subtitle: String::new(),
                body: ItemBody::Service {
                    entries: vec![PlanEntry {
                        label: "John 3:16".into(),
                        body: PlanBody::Scripture {
                            translation: "KJV".into(),
                            book_number: 43,
                            chapter: 3,
                            verse: 16,
                            end_verse: 16,
                        },
                    }],
                },
                path: None,
                updated_at: 0,
            })
            .expect("save");

        let ItemBody::Service { entries } =
            catalog.get(saved.id.unwrap()).expect("get").unwrap().body
        else {
            panic!("expected a service");
        };
        assert_eq!(
            entries[0].body,
            PlanBody::Scripture {
                translation: "KJV".into(),
                book_number: 43,
                chapter: 3,
                verse: 16,
                end_verse: 16,
            }
        );
    }

    #[test]
    fn media_paths_lists_only_what_lives_outside_the_database() {
        // These become asset-protocol grants, so a song leaking in here would
        // widen the webview's reach for no reason.
        let catalog = Catalog::in_memory().expect("catalog");
        catalog.save(&song("Amazing Grace", &["a"])).expect("save");
        for (kind, path) in [
            (ItemBody::Image, "/pictures/dove.jpg"),
            (ItemBody::Media { looping: false }, "/clips/welcome.mp4"),
        ] {
            catalog
                .save(&Item {
                    id: None,
                    title: "asset".into(),
                    subtitle: String::new(),
                    body: kind,
                    path: Some(path.into()),
                    updated_at: 0,
                })
                .expect("save");
        }

        let mut paths = catalog.media_paths().expect("paths");
        paths.sort();
        assert_eq!(paths, vec!["/clips/welcome.mp4", "/pictures/dove.jpg"]);
    }

    #[test]
    fn an_empty_query_lists_rather_than_erroring() {
        let catalog = Catalog::in_memory().expect("catalog");
        catalog.save(&song("Amazing Grace", &["a"])).expect("save");
        assert_eq!(catalog.search("   ", Some("song"), 10).expect("search").len(), 1);
    }
}

