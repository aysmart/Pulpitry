import { invoke } from "@tauri-apps/api/core";

import type { Item, SongRights, SongSection } from "./catalog";

/**
 * The AI Song Finder: the catalogue that comes with a subscription.
 *
 * See src-tauri/src/songfinder.rs for what it is and why it is the one part of
 * Pulpitry that is not on the machine. This end only asks and shows.
 */
/**
 * Whether the catalogue is actually being served yet.
 *
 * False until the songs are in it. Everything on this side is finished and
 * tested -- the search, the rights, previewing a song before it is added, the
 * subscription gate -- and the one thing missing is the catalogue itself,
 * which is assembled and hosted rather than shipped. A pane that searched it
 * anyway would answer every church with an error they cannot act on, which is
 * a worse first impression than saying plainly that it is not open yet.
 *
 * One constant, read in one place. When the catalogue is served this becomes
 * true and nothing else changes.
 */
export const CATALOGUE_OPEN = false;

export interface SongFinderHit {
  id: string;
  title: string;
  author: string;
  /** The first line, which is how half a congregation names a song. */
  opening: string;
  rights: SongRights["status"] | string;
  sections: number;
}

export interface SongFinderSong {
  id: string;
  title: string;
  author: string;
  sections: SongSection[];
  rights: SongRights;
}

export const songFinderSearch = (query: string, limit = 40) =>
  invoke<SongFinderHit[]>("songfinder_search", { query, limit });

export const songFinderGet = (id: string) =>
  invoke<SongFinderSong>("songfinder_get", { id });

/** Adds it to this church's library and hands back the row that was saved. */
export const songFinderAdd = (id: string) => invoke<Item>("songfinder_add", { id });

/** What a rights status means, in the words an operator can act on. */
export const RIGHTS_LABEL: Record<string, string> = {
  publicDomain: "Public domain",
  licensed: "Licensed",
  restricted: "Restricted",
  unknown: "Rights unchecked",
};
