import { useCallback, useEffect, useState } from "react";

import { adjacentVerse, type Verse } from "./bible";
import type { SongSection } from "./catalog";
import {
  componentText,
  getLive,
  onLive,
  setLive,
  type LiveContent,
  type SlideComponent,
  type SlideLayout,
  type TextBlock,
} from "./projector";

/**
 * Something the operator can stage and put on the projector.
 *
 * A union rather than a bare verse list, because the things a service puts on
 * a screen are genuinely different shapes: a passage steps by verse, a song by
 * section, and a picture, clip or written slide not at all.
 */
export type Presentable =
  | { kind: "scripture"; verses: Verse[] }
  | {
      kind: "lyric";
      songId: number;
      title: string;
      index: number;
      sections: SongSection[];
    }
  | { kind: "image"; itemId: number; title: string; path: string }
  | {
      kind: "media";
      itemId: number;
      title: string;
      path: string;
      looping: boolean;
    }
  | {
      kind: "slide";
      itemId: number;
      title: string;
      /** What every slide made before components existed carries. */
      blocks: TextBlock[];
      /** Preferred where present; see the note on the catalog's slide item. */
      components?: SlideComponent[];
      layout?: SlideLayout;
    };

/** The section a lyric item currently points at. */
export function currentSection(item: Presentable): SongSection | null {
  return item.kind === "lyric" ? (item.sections[item.index] ?? null) : null;
}

export function presentableText(item: Presentable): string {
  if (item.kind === "scripture")
    return item.verses.map((verse) => verse.text).join(" ");
  // A slide is already written out; joining it is how a list summarises it.
  if (item.kind === "slide")
    return item.components && item.components.length > 0
      ? item.components.map(componentText).join(" ")
      : item.blocks.map((block) => block.text).join(" ");
  // A picture has no text, and captioning it with its filename would put the
  // filename on the projector.
  if (item.kind === "image" || item.kind === "media") return "";
  return currentSection(item)?.lines.join(" ") ?? "";
}

/** "John 3:16-18 (KJV)" for a passage, "Amazing Grace — Chorus" for a song. */
export function presentableLabel(item: Presentable): string {
  if (item.kind === "lyric") {
    const label = currentSection(item)?.label;
    return label ? `${item.title} — ${label}` : item.title;
  }
  if (item.kind === "image" || item.kind === "media" || item.kind === "slide")
    return item.title;
  const first = item.verses[0];
  if (!first) return "";
  const last = item.verses[item.verses.length - 1]!;
  const range =
    first.verse === last.verse
      ? `${first.verse}`
      : `${first.verse}-${last.verse}`;
  return `${first.book} ${first.chapter}:${range} (${first.translation})`;
}

export function presentableIds(item: Presentable): number[] {
  return item.kind === "scripture" ? item.verses.map((verse) => verse.id) : [];
}

export function toLiveContent(item: Presentable): LiveContent {
  if (item.kind === "slide") {
    /*
     * The title, as scripture and lyrics both do.
     *
     * It was empty here, which cost nothing until a slide became the way an
     * original-language word reaches the screen: staging ἀγάπη sent the
     * transliteration and the gloss over the mirror with no title and no
     * reference, so a paired Castavox drew two unlabelled lines and the stream
     * showed a Greek word nobody could place.
     */
    return {
      body:
        item.components && item.components.length > 0
          ? {
              kind: "composed",
              components: item.components,
              layout: item.layout ?? "stacked",
            }
          : { kind: "richText", blocks: item.blocks },
      caption: presentableLabel(item),
      ids: [],
      progress: 0,
    };
  }
  if (item.kind === "image") {
    return {
      body: { kind: "image", path: item.path },
      caption: "",
      ids: [],
      progress: 0,
    };
  }
  if (item.kind === "media") {
    return {
      body: { kind: "media", path: item.path, looping: item.looping },
      caption: "",
      ids: [],
      progress: 0,
    };
  }
  if (item.kind === "lyric") {
    const section = currentSection(item);
    /*
     * A deck's section is a slide, and is drawn as one.
     *
     * Generated slides are kept as a deck, and a deck was staged as a song --
     * which meant a slide's title went to the section picker and never to the
     * wall, because a song's label is "Chorus" and nobody projects that. The
     * strongest line on the slide was the one the congregation never saw.
     */
    if (section?.components && section.components.length > 0) {
      return {
        body: {
          kind: "composed",
          components: section.components,
          layout: section.layout ?? "stacked",
        },
        /*
         * The slide's own heading, and not the deck's name with it.
         *
         * A song's section label is structural -- "Chorus" names nothing on
         * its own, so it goes on screen carrying the song's title. A slide's
         * label is the heading the preacher's point was given, and the deck's
         * title is the service's, repeated on every slide. Together they came
         * to "Recognizing The Difference Between Similar Patterns — Why Clear
         * Comparison Matters", which does not fit a card and pushed the half
         * that mattered off the end of it.
         */
        caption: section.label || item.title,
        ids: [],
        progress: 0,
      };
    }
    return {
      // Lines stay separate: a lyric breaks where the writer broke it, and
      // reflowing it into a paragraph makes it unsingable.
      body: { kind: "lyric", lines: section?.lines ?? [] },
      caption: presentableLabel(item),
      ids: [],
      progress: 0,
    };
  }
  return {
    body: {
      kind: "scripture",
      lines: item.verses.map((verse) => ({
        number: verse.verse,
        text: verse.text,
      })),
    },
    caption: presentableLabel(item),
    ids: presentableIds(item),
    progress: 0,
  };
}

/** Identity for dedup: same verses, or same section of the same song. */
function keyOf(item: Presentable): string {
  switch (item.kind) {
    case "scripture":
      return `v:${presentableIds(item).join(",")}`;
    case "lyric":
      return `s:${item.songId}:${item.index}`;
    default:
      return `${item.kind[0]}:${item.itemId}`;
  }
}

/**
 * Preview and Live for the operator window.
 *
 * Preview is local — only this window cares what is staged next. Live is not:
 * it belongs to the Rust side so the projector and this window render from one
 * source and cannot disagree about what the congregation is seeing.
 *
 * What comes next belongs to the service plan, in [`useSchedule`], because it
 * outlives the session.
 */
export function usePresentation() {
  const [preview, setPreview] = useState<Presentable | null>(null);
  const [live, setLiveState] = useState<LiveContent | null>(null);
  const [history, setHistory] = useState<Presentable[]>([]);
  // Verse ids identify live scripture, but a lyric has none, so remember what
  // this window last put up. Only this window displays, so it stays accurate.
  const [liveKey, setLiveKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void getLive()
      .then((current) => active && setLiveState(current))
      .catch(() => undefined);
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

  /**
   * Puts something on screen, and stages it at the same time.
   *
   * Takes what to show rather than reading `preview`, which is what makes a
   * double-click work at all: React has not re-rendered between the click that
   * staged it and the one that displayed it, so a version reading state would
   * put the *previous* item on screen — in front of a congregation, once, with
   * no obvious cause.
   */
  const show = useCallback((item: Presentable) => {
    setPreview(item);
    void setLive(toLiveContent(item));

    const key = keyOf(item);
    setLiveKey(key);
    setHistory((current) => {
      // Re-displaying a passage should move it, not duplicate it.
      const withoutDuplicate = current.filter((entry) => keyOf(entry) !== key);
      return [item, ...withoutDuplicate].slice(0, 50);
    });
  }, []);

  /** Sends whatever is staged. The Enter key, and the Display button. */
  const display = useCallback(() => {
    if (preview) show(preview);
  }, [preview, show]);

  /**
   * Stage and send in one gesture.
   *
   * A double-click, and the reason it is worth having: during a service the
   * operator usually knows exactly what they want on the wall, and making them
   * click and then press Display is two acts for one intention. Single click
   * still stages, so the cautious path is unchanged and is still the default.
   */
  const showVerses = useCallback(
    (verses: Verse[]) => {
      if (verses.length > 0) show({ kind: "scripture", verses });
    },
    [show],
  );

  const showVerse = useCallback(
    (verse: Verse) => showVerses([verse]),
    [showVerses],
  );
  const showItem = useCallback((item: Presentable) => show(item), [show]);

  const clearLive = useCallback(() => {
    void setLive(null);
  }, []);

  /**
   * Winds what is live to a point in it, from 0 at the top to 1 at the end.
   *
   * For the one body that does not fit on a screen: a lexicon entry runs to
   * several hundred words, and the choice before this was between clipping it
   * and shrinking it to a size nobody at the back can read.
   *
   * Takes a fraction rather than a number of screenfuls, because a screenful is
   * a different amount of text on every surface showing this — the projector,
   * the second display and a paired Castavox all differ, and a frame number
   * that exists on one of them does not exist on the others. Whoever calls this
   * converts, using the measurement it has.
   */
  const wind = useCallback((progress: number) => {
    setLiveState((current) => {
      if (!current) return current;
      const next = { ...current, progress: Math.min(1, Math.max(0, progress)) };
      if (next.progress === current.progress) return current;
      void setLive(next);
      return next;
    });
  }, []);

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

      // A picture, clip or slide is one thing; there is nowhere to step to.
      if (preview.kind !== "scripture" && preview.kind !== "lyric") return;

      if (preview.kind === "lyric") {
        const index = preview.index + (forward ? 1 : -1);
        // Stop at the ends. Running off a song into whatever came before it in
        // the library would be worse than doing nothing.
        if (index < 0 || index >= preview.sections.length) return;
        next = { ...preview, index };
      } else {
        const edge = forward
          ? preview.verses[preview.verses.length - 1]
          : preview.verses[0];
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
    preview?.kind === "scripture" ||
    (preview?.kind === "lyric" && preview.index > 0);
  const canStepForward =
    preview?.kind === "scripture" ||
    (preview?.kind === "lyric" && preview.index < preview.sections.length - 1);

  return {
    preview,
    live,
    liveKey,
    history,
    keyOf,
    previewVerse,
    previewVerses,
    previewItem,
    display,
    showVerse,
    showVerses,
    showItem,
    clearLive,
    wind,
    step,
    canStepBack,
    canStepForward,
  };
}
