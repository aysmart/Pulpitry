import { invoke } from "@tauri-apps/api/core";

import type { Background, SlideElement } from "./design";
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
  /**
   * The slide as the operator laid it out, where they did.
   *
   * Beside `components` rather than replacing them, on the same terms `blocks`
   * and `components` already coexist: a generated sermon deck has components
   * and no elements, and it goes on drawing exactly as it did. Where elements
   * are present they *are* the slide — see lib/design.ts — and the editor
   * clears the components it grew from, so nothing ends up with two layouts
   * that disagree.
   */
  elements?: SlideElement[];
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
  /**
   * How a picture or a clip meets the frame.
   *
   * `fill` crops it to the whole screen; false fits it whole inside the frame
   * with the backdrop showing around it. Filling is the common case -- a
   * picture staged as content is meant to *be* the screen -- but a graphic
   * with words near its edges wants fitting, so it is a switch and not a rule.
   */
  | { kind: "image"; fill: boolean }
  | { kind: "media"; looping: boolean; fill: boolean }
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
  | {
      kind: "deck";
      sections: SongSection[];
      /**
       * What every slide in it is drawn against.
       *
       * On the deck rather than on each slide because a church makes a deck to
       * look like one thing, and per-slide backgrounds are mostly a way to end
       * up with a deck that does not match itself. Absent on every deck made
       * before the editor existed, which reads as "use the church's theme" —
       * exactly how those decks look today.
       */
      background?: Background | null;
    }
  /** A service plan: the running order for one gathering. */
  | { kind: "service"; entries: PlanEntry[] }
  /**
   * The songs for one gathering, which is not the same list as the plan.
   *
   * Two lists because two people build them, usually on different days: the
   * plan is the shape of the service, the set is what the band is playing.
   * Held apart so that the worship leader reordering their songs does not
   * reorder the service, and the person planning the service cannot delete a
   * song out from under the band.
   */
  | { kind: "songSet"; entries: PlanEntry[] };

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
