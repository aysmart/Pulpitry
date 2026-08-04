import { invoke } from "@tauri-apps/api/core";

import type { TextBlock } from "./projector";
import type { ProjectorTheme } from "./theme";

/** A labelled block of a song: "Verse 1", "Chorus", "Bridge". */
export interface SongSection {
  label: string;
  /** Kept as written. A lyric breaks where the writer broke it. */
  lines: string[];
}

/** The part of a library item that differs by kind. */
export type ItemBody =
  | { kind: "song"; sections: SongSection[] }
  | { kind: "image" }
  | { kind: "media"; looping: boolean }
  | { kind: "template"; theme: ProjectorTheme }
  | { kind: "slide"; blocks: TextBlock[] };

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
