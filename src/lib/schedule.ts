import { getChapter, type Verse } from "./bible";
import { catalogGet, type Item, type PlanEntry } from "./catalog";
import { presentableLabel, type Presentable } from "./usePresentation";

/**
 * Turning what is staged into a line of the plan.
 *
 * Only the reference is kept. Snapshotting the verse text or the lyric would
 * make a plan that disagrees with the library the moment either is corrected,
 * and the library is the thing that goes on the screen.
 */
export function entryFor(item: Presentable): PlanEntry {
  if (item.kind === "lyric") {
    return { label: item.title, body: { kind: "item", itemId: item.songId } };
  }
  if (item.kind === "image" || item.kind === "media" || item.kind === "slide") {
    return { label: item.title, body: { kind: "item", itemId: item.itemId } };
  }
  const first = item.verses[0]!;
  const last = item.verses[item.verses.length - 1]!;
  return {
    label: presentableLabel(item),
    body: {
      kind: "scripture",
      translation: first.translation,
      bookNumber: first.bookNumber,
      chapter: first.chapter,
      verse: first.verse,
      endVerse: last.verse,
    },
  };
}

/** A heading in the running order — something the service does, not shows. */
export function noteEntry(label: string): PlanEntry {
  return { label, body: { kind: "note" } };
}

/**
 * Looks a line of the plan back up in the library.
 *
 * Returns null when there is nothing to stage: a note, a deleted song, or a
 * passage in a translation this machine does not have. The caller says so
 * rather than staging something the operator did not plan.
 */
export async function resolveEntry(entry: PlanEntry): Promise<Presentable | null> {
  if (entry.body.kind === "note") return null;

  if (entry.body.kind === "scripture") {
    const { translation, bookNumber, chapter, verse, endVerse } = entry.body;
    const chapterVerses = await getChapter(translation, bookNumber, chapter);
    const passage = chapterVerses.filter(
      (candidate: Verse) => candidate.verse >= verse && candidate.verse <= endVerse,
    );
    return passage.length > 0 ? { kind: "scripture", verses: passage } : null;
  }

  const item = await catalogGet(entry.body.itemId);
  return item ? presentableFor(item) : null;
}

/** What a library item looks like on the stage, if it can go there yet. */
export function presentableFor(item: Item): Presentable | null {
  if (item.id === null) return null;

  switch (item.body.kind) {
    case "song":
      return {
        kind: "lyric",
        songId: item.id,
        title: item.title,
        index: 0,
        sections: item.body.sections,
      };
    case "image":
      // The file is the item. Without a path there is nothing to show, which
      // is a broken row rather than a blank slide.
      return item.path
        ? { kind: "image", itemId: item.id, title: item.title, path: item.path }
        : null;
    case "media":
      return item.path
        ? {
            kind: "media",
            itemId: item.id,
            title: item.title,
            path: item.path,
            looping: item.body.looping,
          }
        : null;
    case "slide":
      return {
        kind: "slide",
        itemId: item.id,
        title: item.title,
        blocks: item.body.blocks,
      };
    default:
      // A template is styling, not something to put on the screen.
      return null;
  }
}

/** The current title of whatever an entry points at, for correcting a stale label. */
export async function labelFor(entry: PlanEntry): Promise<string | null> {
  if (entry.body.kind !== "item") return null;
  const item = await catalogGet(entry.body.itemId);
  return item?.title ?? null;
}

/**
 * A default name for a plan the operator never got round to naming.
 *
 * Dated rather than numbered: services are found by when they happened.
 */
export function defaultServiceName(now = new Date()): string {
  return now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
