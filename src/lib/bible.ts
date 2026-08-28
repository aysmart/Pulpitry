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

export const getChapter = (
  translation: string,
  bookNumber: number,
  chapter: number,
) => invoke<Verse[]>("get_chapter", { translation, bookNumber, chapter });

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
) =>
  invoke<Verse | null>("adjacent_verse", {
    translation,
    bookNumber,
    chapter,
    verse,
    forward,
  });

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

/** One word of the Greek or Hebrew behind a verse. */
export interface OriginalWord {
  original: string;
  transliteration: string;
  gloss: string;
  /** Disambiguated Strong's — `G0025`, `H1254A`. */
  strongs: string;
  morphology: string;
  lemma: string;
}

/**
 * The original language behind one verse, in reading order.
 *
 * Empty where there is none, which is not a fault: versification differences
 * and the Apocrypha both produce verses the interlinear does not cover, and an
 * operator who opened the panel on one should see nothing rather than a
 * complaint.
 */
export const originalWords = (book: string, chapter: number, verse: number) =>
  invoke<OriginalWord[]>("original_words", { book, chapter, verse });

/** One Strong's entry, from the bundled brief lexicons. */
export interface LexiconEntry {
  strongs: string;
  lemma: string;
  transliteration: string;
  part: string;
  gloss: string;
  /** The full entry, paragraphs separated by newlines. Plain text. */
  definition: string;
  /** Thayer's, where there is one. Greek New Testament only. */
  thayer: string;
}

/** What a Strong's number means, or null where the lexicon has no entry. */
export const lexiconEntry = (strongs: string) =>
  invoke<LexiconEntry | null>("lexicon_entry", { strongs });

/**
 * One row of the scripture library: a translation this church has, or could.
 *
 * The join between the published catalogue and what is installed happens in
 * Rust, because the states worth getting right are the awkward ones — a
 * translation installed from a catalogue that no longer offers it is still
 * installed, and still has to appear.
 */
export interface Offered {
  id: string;
  name: string;
  year: number;
  /** Empty for anything the catalogue does not describe. */
  language: string;
  /** Compressed download size; zero once it is installed. */
  bytes: number;
  verseCount: number;
  installed: boolean;
  /** What to know before choosing it: a partial Bible, or one with gaps. */
  note: string | null;
  licence: string | null;
  attribution: string | null;
}

export interface TranslationProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
}

/** Everything a church could read. Rejects when the catalogue is unreachable. */
export const translationLibrary = (): Promise<Offered[]> =>
  invoke<Offered[]>("translation_library");

export const installTranslation = (id: string): Promise<void> =>
  invoke("install_translation", { id });

export const removeTranslation = (id: string): Promise<void> =>
  invoke("remove_translation", { id });

export const onTranslationProgress = (
  handle: (progress: TranslationProgress) => void,
): Promise<UnlistenFn> =>
  listen<TranslationProgress>("translation-progress", (event) =>
    handle(event.payload),
  );

/**
 * The texts whose licence obliges us to name them.
 *
 * CC BY-SA permits the commercial use we make of these and asks for
 * attribution in return, so showing them is a condition of shipping the text
 * rather than a credit we chose to give. Read from what is installed, so it
 * stays right for a translation a church downloaded.
 */
export const bibleAttributions = (): Promise<string[]> =>
  invoke<string[]>("bible_attributions");
