import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Translation {
  id: string;
  name: string;
  year: number;
  verseCount: number;
}

export interface Book {
  number: number;
  name: string;
  chapters: number;
}

export interface Verse {
  id: number;
  translation: string;
  bookNumber: number;
  book: string;
  chapter: number;
  verse: number;
  text: string;
}

export interface Reference {
  bookNumber: number;
  book: string;
  chapter: number;
  verse: number | null;
  /** Set when the operator typed a range: "John 3:16-18" ends at 18. */
  endVerse: number | null;
}

export interface LibraryStatus {
  ready: boolean;
  translations: Translation[];
  /** Name of the translation currently importing, if any. */
  importing: string | null;
  error: string | null;
}

export const EVENT_LIBRARY = "library:status";

export const libraryStatus = () => invoke<LibraryStatus>("library_status");

export const listBooks = (translation: string) =>
  invoke<Book[]>("list_books", { translation });

export const getChapter = (translation: string, bookNumber: number, chapter: number) =>
  invoke<Verse[]>("get_chapter", { translation, bookNumber, chapter });

export const searchVerses = (translation: string, query: string, limit = 50) =>
  invoke<Verse[]>("search_verses", { translation, query, limit });

export const resolveReference = (translation: string, reference: string) =>
  invoke<Reference | null>("resolve_reference", { translation, reference });

export const adjacentVerse = (
  translation: string,
  bookNumber: number,
  chapter: number,
  verse: number,
  forward: boolean,
) => invoke<Verse | null>("adjacent_verse", { translation, bookNumber, chapter, verse, forward });

export const onLibraryStatus = (
  handler: (status: LibraryStatus) => void,
): Promise<UnlistenFn> =>
  listen<LibraryStatus>(EVENT_LIBRARY, (event) => handler(event.payload));

/**
 * How a verse reads in the UI: "John 3:16", or "John 3" for a chapter the
 * speaker named without a verse.
 */
export function formatReference(verse: Verse, wholeChapter = false): string {
  return wholeChapter
    ? `${verse.book} ${verse.chapter}`
    : `${verse.book} ${verse.chapter}:${verse.verse}`;
}
