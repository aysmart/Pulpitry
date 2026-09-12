import { invoke } from "@tauri-apps/api/core";

import type { Item, SongRights, SongSection } from "./catalog";

/**
 * The AI Song Finder: the catalogue that comes with a subscription.
 *
 * See src-tauri/src/songfinder.rs for what it is and why it is the one part of
 * Pulpitry that is not on the machine. This end only asks and shows.
 */
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
