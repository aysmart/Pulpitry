import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
 * False while the songs were still being assembled: a pane that searched an
 * empty catalogue would answer every church with an error they cannot act on,
 * which is a worse first impression than saying plainly that it is not open.
 *
 * One constant, read in one place, and it is true now. What gates it from here
 * is the subscription, which is the broker's business rather than this file's.
 */
export const CATALOGUE_OPEN = true;

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

/**
 * What this machine holds of the catalogue.
 *
 * The catalogue is pulled once and searched locally from then on, so this is
 * the difference between a pane that can answer and one that has nothing to
 * answer from. `ready` is false on a machine that has never downloaded it and
 * on one where the file has been removed.
 */
export interface SongFinderStatus {
  ready: boolean;
  /** The bank this copy came from, so a newer one can be offered later. */
  version: string;
  songs: number;
}

export const songFinderStatus = () =>
  invoke<SongFinderStatus>("songfinder_status");

/** What the broker is serving, so a copy already held can be compared. */
export interface SongFinderAvailable {
  version: string;
  songs: number;
}

/**
 * Asks what the catalogue is now, without downloading it.
 *
 * Needed because the catalogue is pulled once and then searched locally
 * forever: before this, a church that had it kept whatever it first got, and
 * the bank growing did not reach a single machine that had already pulled.
 */
export const songFinderLatest = () =>
  invoke<SongFinderAvailable>("songfinder_latest");

/** Downloads the catalogue. The one thing here that needs the network. */
export const songFinderPull = () =>
  invoke<SongFinderStatus>("songfinder_pull");

/**
 * How far the download has got: songs held, and songs expected.
 *
 * Fourteen megabytes on church wifi is a minute or two, and a button that does
 * nothing visible for two minutes is a button somebody presses again.
 */
export const onSongFinderPull = (
  handler: (held: number, expected: number) => void,
): Promise<UnlistenFn> =>
  listen<[number, number]>("songfinder:pull", (event) =>
    handler(event.payload[0], event.payload[1]),
  );

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
