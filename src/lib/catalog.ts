import { invoke } from "@tauri-apps/api/core";

import type { TextBlock } from "./projector";
import type { ProjectorTheme } from "./theme";
import type { SlideComponent, SlideLayout } from "./projector";

/** A labelled block of a song: "Verse 1", "Chorus", "Bridge". */
export interface SongSection {
  label: string;
  /** Kept as written. A lyric breaks where the writer broke it. */
  lines: string[];
  /**
   * A slide's components, where this section is a slide rather than a verse.
   *
   * Songs never set these; decks do. The two share this type because they share
   * everything else that matters — a labelled part of a longer thing that the
   * operator steps through one at a time — and giving a deck its own near-copy
   * would mean maintaining the stepping twice.
   *
   * Where they are present the section is drawn as a composed slide, and where
   * they are absent it is drawn as lines, which is what every deck saved before
   * this carries.
   */
  components?: SlideComponent[];
  layout?: SlideLayout;
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
  /**
   * A slide.
   *
   * `blocks` is what every slide saved before components existed carries, and
   * it stays: a slide from last Sunday loads and renders exactly as it did.
   * `components` is preferred when present, so the two can coexist for as long
   * as it takes for the old ones to be replaced -- which may be never, and does
   * not need to be.
   */
  | {
      kind: "slide";
      blocks: TextBlock[];
      components?: SlideComponent[];
      layout?: SlideLayout;
    }
  /**
   * A sermon's slides, kept together and stepped in order.
   *
   * A group rather than a dozen loose slides, for the same reason a song is one
   * item and not eight verses: they were made together and are used in order,
   * and a library that scattered them would make the operator reassemble on
   * Sunday what was assembled on Friday.
   *
   * It borrows a song's section shape because it *is* that shape — a label and
   * some lines — so everything that already steps a song steps this too.
   */
  | { kind: "deck"; sections: SongSection[] }
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
