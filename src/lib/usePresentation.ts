import { useCallback, useEffect, useState } from "react";

import { adjacentVerse, type Verse } from "./bible";
import type { SongSection } from "./catalog";
import { getLive, onLive, setLive, type LiveContent } from "./projector";

/**
 * Something the operator can stage and put on the projector.
 *
 * Scripture is the only kind today; songs, images and slides join it as their
 * libraries land, which is why this is a union rather than a bare verse list.
 */
export type Presentable =
  | { kind: "scripture"; verses: Verse[] }
  | { kind: "lyric"; songId: number; title: string; index: number; sections: SongSection[] };

/** The section a lyric item currently points at. */
export function currentSection(item: Presentable): SongSection | null {
  return item.kind === "lyric" ? (item.sections[item.index] ?? null) : null;
}

export function presentableText(item: Presentable): string {
  if (item.kind === "scripture") return item.verses.map((verse) => verse.text).join(" ");
  return currentSection(item)?.lines.join(" ") ?? "";
}

/** "John 3:16-18 (KJV)" for a passage, "Amazing Grace — Chorus" for a song. */
export function presentableLabel(item: Presentable): string {
  if (item.kind === "lyric") {
    const label = currentSection(item)?.label;
    return label ? `${item.title} — ${label}` : item.title;
  }
  const first = item.verses[0];
  if (!first) return "";
  const last = item.verses[item.verses.length - 1]!;
  const range =
    first.verse === last.verse ? `${first.verse}` : `${first.verse}-${last.verse}`;
  return `${first.book} ${first.chapter}:${range} (${first.translation})`;
}

export function presentableIds(item: Presentable): number[] {
  return item.kind === "scripture" ? item.verses.map((verse) => verse.id) : [];
}

export function toLiveContent(item: Presentable): LiveContent {
  if (item.kind === "lyric") {
    return {
      // Lines stay separate: a lyric breaks where the writer broke it, and
      // reflowing it into a paragraph makes it unsingable.
      body: { kind: "lyric", lines: currentSection(item)?.lines ?? [] },
      caption: presentableLabel(item),
      ids: [],
    };
  }
  return {
    body: {
      kind: "scripture",
      lines: item.verses.map((verse) => ({ number: verse.verse, text: verse.text })),
    },
    caption: presentableLabel(item),
    ids: presentableIds(item),
  };
}

/** Longer than any service; the queue is a running order, not an archive. */
const MAX_QUEUE = 200;

/** Identity for dedup: same verses, or same section of the same song. */
function keyOf(item: Presentable): string {
  return item.kind === "scripture"
    ? `v:${presentableIds(item).join(",")}`
    : `s:${item.songId}:${item.index}`;
}

/**
 * Preview, Live and Queue for the operator window.
 *
 * Preview is local — only this window cares what is staged next. Live is not:
 * it belongs to the Rust side so the projector and this window render from one
 * source and cannot disagree about what the congregation is seeing.
 */
export function usePresentation() {
  const [preview, setPreview] = useState<Presentable | null>(null);
  const [live, setLiveState] = useState<LiveContent | null>(null);
  const [history, setHistory] = useState<Presentable[]>([]);
  const [queue, setQueue] = useState<Presentable[]>([]);
  // Verse ids identify live scripture, but a lyric has none, so remember what
  // this window last put up. Only this window displays, so it stays accurate.
  const [liveKey, setLiveKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void getLive().then((current) => active && setLiveState(current)).catch(() => undefined);
    void onLive((next) => {
      if (!active) return;
      setLiveState(next);
      if (!next) setLiveKey(null);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const previewVerses = useCallback((verses: Verse[]) => {
    if (verses.length === 0) return;
    setPreview({ kind: "scripture", verses });
  }, []);

  const previewItem = useCallback((item: Presentable) => setPreview(item), []);

  const previewVerse = useCallback(
    (verse: Verse) => previewVerses([verse]),
    [previewVerses],
  );

  const display = useCallback(() => {
    if (!preview) return;
    void setLive(toLiveContent(preview));

    const key = keyOf(preview);
    setLiveKey(key);
    setHistory((current) => {
      // Re-displaying a passage should move it, not duplicate it.
      const withoutDuplicate = current.filter((item) => keyOf(item) !== key);
      return [preview, ...withoutDuplicate].slice(0, 50);
    });
    // Putting a queued item live takes it off the running order.
    setQueue((current) => current.filter((item) => keyOf(item) !== key));
  }, [preview]);

  const clearLive = useCallback(() => {
    void setLive(null);
  }, []);

  const enqueue = useCallback((item: Presentable) => {
    setQueue((current) =>
      current.some((existing) => keyOf(existing) === keyOf(item))
        ? current
        : [...current, item].slice(0, MAX_QUEUE),
    );
  }, []);

  const dequeue = useCallback((key: string) => {
    setQueue((current) => current.filter((item) => keyOf(item) !== key));
  }, []);

  const clearQueue = useCallback(() => setQueue([]), []);

  /**
   * Moves one step through whatever is staged.
   *
   * A song walks its own sections; scripture walks verses, moving by one verse
   * rather than by the length of the staged passage. Either way, if the staged
   * item is the one on screen, the screen follows — which is the whole point
   * during a sung verse.
   */
  const step = useCallback(
    async (forward: boolean) => {
      if (!preview) return;

      let next: Presentable | null = null;

      if (preview.kind === "lyric") {
        const index = preview.index + (forward ? 1 : -1);
        // Stop at the ends. Running off a song into whatever came before it in
        // the library would be worse than doing nothing.
        if (index < 0 || index >= preview.sections.length) return;
        next = { ...preview, index };
      } else {
        const edge = forward ? preview.verses[preview.verses.length - 1] : preview.verses[0];
        if (!edge) return;
        const verse = await adjacentVerse(
          edge.translation,
          edge.bookNumber,
          edge.chapter,
          edge.verse,
          forward,
        );
        if (!verse) return;
        next = { kind: "scripture", verses: [verse] };
      }

      const wasLive = liveKey === keyOf(preview);
      setPreview(next);
      if (wasLive) {
        setLiveKey(keyOf(next));
        void setLive(toLiveContent(next));
      }
    },
    [preview, liveKey],
  );

  /**
   * Whether stepping would go anywhere. Known exactly for a song; scripture
   * cannot be answered without a query, so it stays available.
   */
  const canStepBack =
    preview !== null && (preview.kind !== "lyric" || preview.index > 0);
  const canStepForward =
    preview !== null &&
    (preview.kind !== "lyric" || preview.index < preview.sections.length - 1);

  return {
    preview,
    live,
    liveKey,
    history,
    queue,
    keyOf,
    previewVerse,
    previewVerses,
    previewItem,
    display,
    clearLive,
    enqueue,
    dequeue,
    clearQueue,
    step,
    canStepBack,
    canStepForward,
  };
}
