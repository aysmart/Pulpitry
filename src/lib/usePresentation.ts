import { useCallback, useEffect, useState } from "react";

import { adjacentVerse, getChapter, listBooks, type Verse } from "./bible";
import type { SongSection } from "./catalog";
import type { Background } from "./design";
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
      /**
       * A song, or a deck of slides.
       *
       * They share this shape because they are stepped identically — a labelled
       * part of a longer thing, one at a time — and that sharing is worth
       * keeping. What it cost until now is that nothing downstream could tell
       * them apart: a song staged while the operator was on the slide desk
       * appeared in the deck strip as a one-slide deck, and a deck staged on the
       * song desk appeared as a song's parts.
       *
       * They are not the same thing and the panes that show them are not
       * interchangeable, so the item says which it is. Absent on nothing:
       * everything that builds one of these sets it.
       */
      source: "song" | "deck";
      /** A designed deck's background, carried so what goes live has it. */
      background?: Background | null;
    }
  | {
      kind: "image";
      itemId: number;
      title: string;
      path: string;
      fill: boolean;
    }
  | {
      kind: "media";
      itemId: number;
      title: string;
      path: string;
      looping: boolean;
      fill: boolean;
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
      body: { kind: "image", path: item.path, fill: item.fill },
      caption: "",
      ids: [],
      progress: 0,
    };
  }
  if (item.kind === "media") {
    return {
      body: {
        kind: "media",
        path: item.path,
        looping: item.looping,
        fill: item.fill,
      },
      caption: "",
      ids: [],
      progress: 0,
    };
  }
  if (item.kind === "lyric") {
    const section = currentSection(item);

    /*
     * Laid out by hand, and therefore the whole slide.
     *
     * Checked before components on purpose: the editor grows elements out of
     * components the first time a generated deck is opened in it, and from
     * that moment the operator's arrangement is the one that was chosen. The
     * background travels with it, because what is live crosses to four other
     * surfaces and none of them can read the library.
     */
    if (section?.elements && section.elements.length > 0) {
      return {
        body: {
          kind: "designed",
          elements: section.elements,
          background: item.background ?? null,
        },
        caption: section.label || item.title,
        ids: [],
        progress: 0,
      };
    }
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

/**
 * Something that went on the screen, and when.
 *
 * The time is carried rather than derived because it is the only thing that
 * separates two showings of the same passage, and it is what an operator
 * actually reads the list by: "we were on that about ten minutes ago".
 */
export interface Shown {
  item: Presentable;
  /** Epoch milliseconds, from the moment it went live. */
  at: number;
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
  const [history, setHistory] = useState<Shown[]>([]);
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
      // Re-displaying a passage should move it, not duplicate it -- and it
      // takes the newer time with it, which is the one that answers "when were
      // we last on this".
      const withoutDuplicate = current.filter(
        (entry) => keyOf(entry.item) !== key,
      );
      return [{ item, at: Date.now() }, ...withoutDuplicate].slice(0, 50);
    });
  }, []);

  /**
   * Forgets what has been shown.
   *
   * Session-scoped and deliberately so: this is the record of *this* service,
   * and a second service in the same sitting — an evening one, a rehearsal —
   * should not have to read past the morning's. Nothing leaves the projector.
   */
  const clearHistory = useCallback(() => setHistory([]), []);

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
   * Straight to a numbered slide in the staged deck.
   *
   * A deck is kept as a lyric with sections -- that is what a sermon's slides
   * are here -- so "slide four" is its fourth section rather than anything to
   * do with the running order. Counted from one, as a person counts and as the
   * thumbnails are numbered.
   *
   * Nothing at all when the number is past the end: a deck of seven asked for
   * slide twelve is a misheard number, and going to the last slide instead
   * would look like it had worked.
   */
  const goToSlide = useCallback(
    (number: number) => {
      if (!preview || preview.kind !== "lyric") return false;
      const index = number - 1;
      if (index < 0 || index >= preview.sections.length) return false;

      const next = { ...preview, index };
      // The same rule every instruction here follows: if what it replaced was
      // live, the new one is live; if this was only a preview, it stays one.
      const wasLive = liveKey === keyOf(preview);
      setPreview(next);
      if (wasLive) {
        setLiveKey(keyOf(next));
        void setLive(toLiveContent(next));
      }
      return true;
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
  /**
   * Shows the staged passage again in another translation.
   *
   * Changing translation mid-service means one thing: this verse, in that
   * wording. Leaving the old text on the wall is the single outcome nobody
   * asked for — and it was what happened, because changing translation only
   * ever changed what the *next* lookup would search.
   *
   * Found again by book name rather than by the number it had. A book's number
   * belongs to the canon it is in: John is the forty-third book of a Protestant
   * Bible and the fiftieth of a Catholic one, so carrying the number across
   * would put Philippians on the screen.
   *
   * Silent about everything it cannot do. A translation without that book, or
   * without that verse — some omit a handful — leaves the screen as it was,
   * which is a better answer than blanking it during a reading.
   */
  const retranslate = useCallback(
    async (into: string) => {
      const staged = preview;
      if (!staged || staged.kind !== "scripture" || staged.verses.length === 0)
        return;
      const first = staged.verses[0];
      if (!first || first.translation === into) return;

      try {
        const books = await listBooks(into);
        const numbers = new Map(
          books.map((book) => [book.name.toLowerCase(), book.number]),
        );

        // One request per chapter, not per verse: a passage is almost always
        // inside one, and a range of ten verses should not be ten round trips.
        const chapters = new Map<string, Verse[]>();
        const found: Verse[] = [];
        for (const verse of staged.verses) {
          const number = numbers.get(verse.book.toLowerCase());
          if (number === undefined) return;

          const at = `${number}:${verse.chapter}`;
          let loaded = chapters.get(at);
          if (!loaded) {
            loaded = await getChapter(into, number, verse.chapter);
            chapters.set(at, loaded);
          }
          const match = loaded.find((entry) => entry.verse === verse.verse);
          if (!match) return;
          found.push(match);
        }

        // Only back to air if it was on air. Staging something is a decision
        // the operator makes separately from showing it, and a translation
        // change must not quietly promote a preview to the wall.
        if (liveKey && liveKey === keyOf(staged))
          show({ kind: "scripture", verses: found });
        else setPreview({ kind: "scripture", verses: found });
      } catch {
        // A lookup that fails leaves the reading alone. There is nothing here
        // an operator could act on mid-service.
      }
    },
    [preview, liveKey, show],
  );

  /**
   * Goes where a spoken instruction asked, and takes the screen with it.
   *
   * Deliberately the same shape as `step`, because it is the same act: it
   * works from what is *staged* rather than from wherever the chapter browser
   * happens to be pointing, and it carries the screen under exactly the same
   * rule -- if what it replaced was live, the new one is live.
   *
   * Reading the browser instead was the first attempt and was wrong three ways
   * at once: it staged the previous chapter's verse because the new one had
   * not arrived, it needed saying twice for the same reason, and a chapter and
   * verse together did nothing at all.
   *
   * A chapter the book does not have comes back empty and nothing moves:
   * "chapter ninety" in a book with five is a misheard number, and going to
   * the last chapter would look like the instruction worked.
   */
  const goToPassage = useCallback(
    async ({
      book,
      chapter,
      by,
      verse,
    }: {
      book: string | null;
      chapter: number | null;
      by: number;
      verse: number | null;
    }) => {
      if (preview?.kind !== "scripture") return;
      const from = preview.verses[0];
      if (!from) return;

      // The book, when one was named. Looked up in the translation being read,
      // so a canon without that book simply does not move.
      let bookNumber = from.bookNumber;
      let open = from.chapter;
      if (book) {
        const found = (await listBooks(from.translation)).find(
          (entry) => entry.name.toLowerCase() === book.toLowerCase(),
        );
        if (!found) return;
        if (found.number !== bookNumber) open = 1;
        bookNumber = found.number;
      }

      const wanted = by !== 0 ? open + by : (chapter ?? open);
      if (wanted < 1) return;

      const verses = await getChapter(from.translation, bookNumber, wanted);
      if (verses.length === 0) return;

      // A chapter asked for with no verse starts at its first, because that is
      // where a reading starts.
      const target = verses.find((entry) => entry.verse === (verse ?? 1));
      if (!target) return;

      const next: Presentable = { kind: "scripture", verses: [target] };
      const wasLive = liveKey === keyOf(preview);
      setPreview(next);
      if (wasLive) {
        setLiveKey(keyOf(next));
        void setLive(toLiveContent(next));
      }
    },
    [preview, liveKey],
  );

  const canStepForward =
    preview?.kind === "scripture" ||
    (preview?.kind === "lyric" && preview.index < preview.sections.length - 1);

  return {
    preview,
    live,
    liveKey,
    history,
    clearHistory,
    keyOf,
    previewVerse,
    previewVerses,
    previewItem,
    display,
    showVerse,
    showVerses,
    showItem,
    goToPassage,
    goToSlide,
    retranslate,
    clearLive,
    wind,
    step,
    canStepBack,
    canStepForward,
  };
}
