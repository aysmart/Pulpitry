import { invoke } from "@tauri-apps/api/core";

import type { TextBlock } from "./projector";
import type { ProjectorTheme } from "./theme";

/** A labelled block of a song: "Verse 1", "Chorus", "Bridge". */
export interface SongSection {
  label: string;
  /** Kept as written. A lyric breaks where the writer broke it. */
  lines: string[];
}

/** Whether a song's words may lawfully be put on a screen. */
export type RightsStatus = "unknown" | "publicDomain" | "licensed" | "restricted";

/**
 * Where a song's words came from and on what terms.
 *
 * Pulpitry deliberately does not integrate CCLI. CCLI is a licence a church
 * buys and reports against, not a service an app can call, and the obligation
 * is theirs rather than ours. What an app can do is refuse to let the question
 * go unasked, which is what this is for.
 */
export interface SongRights {
  status: RightsStatus;
  author: string;
  /** Separate from the author because words and tune expire separately, and
   *  only the words are what this app reproduces. */
  composer: string;
  /** The terms verbatim: the evidence for what `status` claims. */
  terms: string;
  /** Where the words came from, so the claim can be traced. */
  source: string;
  /** The church's own CCLI song number, kept for their reporting and sent
   *  nowhere. */
  ccli: string;
}

/** A song nobody has answered for yet. Deliberately not "cleared". */
export const unknownRights = (): SongRights => ({
  status: "unknown",
  author: "",
  composer: "",
  terms: "",
  source: "",
  ccli: "",
});

/**
 * What one line of a service plan points at.
 *
 * References, never resolved content: a plan is written days before it runs
 * and kept long afterwards, so it has to survive a song being retitled and the
 * verse library being reimported underneath it.
 */
export type PlanBody =
  | {
      kind: "scripture";
      translation: string;
      bookNumber: number;
      chapter: number;
      verse: number;
      /** Equal to `verse` for a single verse. */
      endVerse: number;
    }
  | { kind: "item"; itemId: number }
  /** A heading with nothing behind it: "Welcome", "Offering", "Sermon". */
  | { kind: "note" };

/** One line of a service plan. */
export interface PlanEntry {
  /**
   * What to show before anything has been looked up, and what makes a service
   * findable by what was in it. Refreshed whenever the item behind it resolves.
   */
  label: string;
  body: PlanBody;
}

/** The part of a library item that differs by kind. */
export type ItemBody =
  | { kind: "song"; sections: SongSection[]; rights: SongRights }
  | { kind: "image" }
  | { kind: "media"; looping: boolean }
  | { kind: "template"; theme: ProjectorTheme }
  | { kind: "slide"; blocks: TextBlock[] }
  /** A service plan: the running order for one gathering. */
  | { kind: "service"; entries: PlanEntry[] };

export type ItemKind = ItemBody["kind"];

export interface Item {
  /** Absent when saving something new. */
  id: number | null;
  title: string;
  subtitle: string;
  body: ItemBody;
  /** External file, for images and media. */
  path: string | null;
  updatedAt: number;
}

export const catalogSave = (item: Item) => invoke<Item>("catalog_save", { item });

export const catalogGet = (id: number) => invoke<Item | null>("catalog_get", { id });

export const catalogRemove = (id: number) => invoke<void>("catalog_remove", { id });

export const catalogList = (kind: ItemKind, limit?: number) =>
  invoke<Item[]>("catalog_list", { kind, limit: limit ?? null });

export const catalogSearch = (query: string, kind?: ItemKind, limit?: number) =>
  invoke<Item[]>("catalog_search", { query, kind: kind ?? null, limit: limit ?? null });

/** A new item of the given kind, ready to save. */
export function newItem(title: string, body: ItemBody, path: string | null = null): Item {
  return { id: null, title, subtitle: "", body, path, updatedAt: 0 };
}
