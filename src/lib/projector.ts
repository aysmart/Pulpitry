import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const EVENT_LIVE = "live:changed";

export interface ScriptureLine {
  number: number;
  text: string;
}

/**
 * A run of authored text with the little formatting a slide needs.
 *
 * Structured rather than HTML on purpose: rich text from an editor would have
 * to be sanitised before reaching the projector, and a closed set of fields
 * cannot carry markup at all.
 */
export interface TextBlock {
  text: string;
  level: "heading" | "body";
  align: "left" | "center" | "right";
  bold: boolean;
  italic: boolean;
}

/**
 * What the congregation is looking at.
 *
 * A tagged union because the things a service puts on screen are genuinely
 * different shapes: a passage is a numbered sequence, a song section is
 * unnumbered lines that must break where they were written, an image has no
 * text, and a clip has a timeline.
 */
/**
 * One thing on a slide.
 *
 * A tagged union for the reason [`LiveBody`] below is one: a table is not a
 * paragraph with tabs in it and a list is not a paragraph with line breaks. The
 * shapes are genuinely different, and flattening them into text is what made
 * every slide a centred heading over centred lines.
 *
 * Only what is actually rendered appears here. A variant nobody draws is a
 * slide that silently comes up blank in front of a congregation, so components
 * are added to this union in the same change that teaches the renderer to draw
 * them.
 */
export type SlideComponent =
  /** A title, a statement set large, or a line of body text. */
  | { kind: "text"; text: string; level: "title" | "statement" | "body" }
  /** Parallel points. `ordered` where the preacher numbered them. */
  | { kind: "list"; items: ListItem[]; ordered: boolean }
  /**
   * A comparison, a rota, a set of figures.
   *
   * Often the literal shape of the argument — "under the law" beside "under
   * grace" — and the one component whose invented contents would be most
   * convincing and least noticed. Every cell is anchored; see slides.rs.
   */
  | { kind: "table"; header: string[]; rows: string[][] }
  /** Something said, with whoever said it. */
  | { kind: "quote"; text: string; attribution: string }
  /** A reference. The verse comes from the library, never from the model. */
  | { kind: "passage"; reference: string }
  /**
   * A picture. Illustrative, and the one component that is not anchored.
   *
   * Everything else on a slide asserts that something was said or is true, so
   * it carries the words it came from and is dropped if they are not in the
   * transcript. A photograph of an open sky asserts nothing. It sets a mood,
   * and there is nothing about it that could be checked even in principle.
   */
  | { kind: "figure"; source: ImageSource; caption?: string };

/**
 * Where a picture came from.
 *
 * One arm for now, and deliberately: a picture the church already holds and
 * chose. Generated pictures are a second arm, and adding it before there is
 * anything that can produce one would be a shape with nothing behind it.
 */
export type ImageSource = {
  from: "library";
  /** The catalogue item, so the picture can be traced back to what it is. */
  itemId: number;
  /**
   * The file, so drawing it needs no lookup.
   *
   * Carried as well as the id because a slide is drawn on a projector window
   * that may be a different process, and a synchronous render cannot go and
   * ask the database where a picture lives.
   */
  path: string;
};

/**
 * How the components on a slide are placed.
 *
 * Deliberately few. An operator choosing under service pressure needs one
 * decision, and a gallery of arrangements is not a decision but a delay.
 *
 * Nobody chooses these, which is the point: a layout is a function of what the
 * slide is made of, so `layoutFor` derives it from the components. Asking the
 * model for one would be a sixth thing it can get wrong on a slide, and the
 * lesson of the anchoring work is that a mechanism beats an instruction.
 *
 * - `section` a movement of the sermon begins: a heading and nothing under it.
 * - `single`  one thing, set large. A statement that stands on its own.
 * - `split`   two things side by side: a picture beside the words, or a
 *             comparison as two headed columns rather than a ruled grid.
 * - `stacked` a heading and what sits beneath it. The common case.
 */
/**
 * One parallel point.
 *
 * A plain string, or a heading with something under it. Both shapes, because a
 * heading is not always there to be had: "he was faithful, he was patient, he
 * was ready" has no headings in it, and inventing three would be inventing --
 * which is the one thing the whole of the anchoring work exists to prevent.
 *
 * Which shape it is decides how the list is *drawn*. Points with headings can
 * be cards, because a card is a heading over a line and a card of one sentence
 * is a bullet in a box, which is worse than a bullet.
 */
export type ListItem = string | { heading: string; text: string };

/** The heading of a point, or nothing. */
export function itemHeading(item: ListItem): string {
  return typeof item === "string" ? "" : item.heading;
}

/** The words of a point, whichever shape it is. */
export function itemText(item: ListItem): string {
  return typeof item === "string" ? item : item.text;
}

export type SlideLayout = "single" | "stacked" | "split" | "section";

/**
 * The arrangement a slide's own contents call for.
 *
 * Every slide was stacked, because the two save paths wrote `"stacked"` in and
 * nothing ever computed anything else. So a slide holding only a heading was
 * drawn as a heading over an empty body -- which is what "those slides with
 * just a title show as broken" was.
 */
/**
 * The arrangement a stored slide should be drawn with.
 *
 * A deck keeps the layout it was saved with, and layouts outlive neither the
 * decks nor the reasoning that produced them. "backed" was saved onto real
 * slides and then withdrawn, and a stored name the renderer no longer has a
 * branch for does not fail loudly -- it falls through to the last arrangement
 * in the list and draws the slide as something nobody chose. A picture ended
 * up over the words that way.
 *
 * So a name that is still known is honoured, and anything else is derived from
 * what the slide is actually made of, which is where every layout comes from
 * in the first place.
 */
export function layoutOf(stored: string | undefined, components: SlideComponent[]): SlideLayout {
  const known: SlideLayout[] = ["single", "stacked", "split", "section"];
  return known.includes(stored as SlideLayout)
    ? (stored as SlideLayout)
    : layoutFor(components);
}

export function layoutFor(components: SlideComponent[]): SlideLayout {
  const body = components.filter(
    (component) => !(component.kind === "text" && component.level === "title"),
  );

  /*
   * A picture sits beside the words, never behind them.
   *
   * Behind them was the first answer and it was wrong. A church's pictures are
   * not stock scenery -- they are the graphics the church already made, and
   * they have words in them. Body text over "tracked in real time" is two sets
   * of words fighting, and no scrim dark enough to win that fight leaves a
   * picture worth showing.
   *
   * Checked before the others because it changes what the slide is.
   */
  if (body.some((component) => component.kind === "figure")) return "split";

  // A heading with nothing under it is not a broken slide, it is a section
  // marker, and it is the one slide that should be set enormous.
  if (body.length === 0) return "section";

  /*
   * A two-column comparison is already side by side; a ruled grid is the
   * awkward way to draw one. Three columns or more is a table and stays one --
   * three panels across a wall are too narrow to read from the back.
   */
  const table = body.find((component) => component.kind === "table");
  if (table && table.kind === "table" && table.header.length === 2) return "split";

  // One thing on a slide gets the room, whether or not a heading names it.
  if (body.length === 1 && components.length === 1) return "single";

  return "stacked";
}

export type LiveBody =
  | { kind: "scripture"; lines: ScriptureLine[] }
  | { kind: "lyric"; lines: string[] }
  | { kind: "richText"; blocks: TextBlock[] }
  /**
   * A slide made of components rather than lines.
   *
   * Beside `richText` rather than replacing it: every slide saved before this
   * existed is a `richText` and still renders exactly as it did.
   */
  | { kind: "composed"; components: SlideComponent[]; layout: SlideLayout }
  | { kind: "image"; path: string }
  | { kind: "media"; path: string; looping: boolean };

export interface LiveContent {
  body: LiveBody;
  /** Shown small beneath: a reference, a song title, or nothing. */
  caption: string;
  /** Verse ids behind this, so lists can highlight what is live. */
  ids: number[];
  /**
   * How far through a long body it has been wound, 0 at the top and 1 at the
   * end.
   *
   * Zero for everything a screen holds at once, which is almost everything: a
   * verse, a chorus, a written slide. It exists for the one thing that does not
   * fit -- a lexicon entry, which runs to several hundred words.
   *
   * # Why a fraction and not a frame number
   *
   * This counted screenfuls, which does not survive two screens. The desk broke
   * one entry into four frames and a paired Castavox broke the same entry into
   * two, because they have different shapes and different amounts of room -- so
   * "frame 3" was a place that existed on one and not the other, and winding
   * there did nothing at all on the screen. The same is true inside this app
   * whenever the projector's display is not the shape of the preview box.
   *
   * A fraction is the one thing every surface can agree on without knowing
   * anything about the others: exact at both ends -- 0 is the first line
   * everywhere, 1 is the last everywhere -- and proportional in between, which
   * is the best available when one surface genuinely shows more text.
   *
   * The operator still steps in whole screenfuls. That conversion happens where
   * the measurement lives, not here.
   */
  progress: number;
}

/** Plain text, for sizing decisions and the operator's panes. */
export function bodyText(body: LiveBody): string {
  switch (body.kind) {
    case "scripture":
      return body.lines.map((line) => line.text).join(" ");
    case "lyric":
      return body.lines.join("\n");
    case "richText":
      return body.blocks.map((block) => block.text).join("\n");
    case "composed":
      return body.components.map(componentText).join("\n");
    default:
      return "";
  }
}

/**
 * Everything readable in a component, as text.
 *
 * Three callers with the same need and different reasons: sizing the type,
 * searching a service, and mirroring to a paired Castavox — whose overlay
 * carries flat strings, because it is a card beside a camera rather than a
 * 16:9 frame. A table has no place in a lower third, so it is not sent as one;
 * it is sent as something that still reads there.
 */
export function componentText(component: SlideComponent): string {
  switch (component.kind) {
    case "text":
      return component.text;
    case "list":
      return component.items
        .map((item) => {
          const heading = itemHeading(item);
          return heading ? `${heading}: ${itemText(item)}` : itemText(item);
        })
        .join("\n");
    case "table":
      /*
       * Each row paired with its heading, rather than cells run together.
       *
       * "Under the law · bondage" survives being read in a strip at the bottom
       * of a video frame. "Under the law Under grace bondage freedom", which is
       * what joining the cells gives, does not — the columns are the meaning
       * and flattening them loses it.
       */
      return component.rows
        .map((row) =>
          row
            .map((cell, index) => {
              const heading = component.header[index];
              return heading ? `${heading}: ${cell}` : cell;
            })
            .join(" · "),
        )
        .join("\n");
    case "quote":
      return component.attribution
        ? `${component.text}\n${component.attribution}`
        : component.text;
    case "passage":
      return component.reference;
    /*
     * A caption, or nothing.
     *
     * Three callers want this text and a picture answers all three the same
     * way. Sizing: a photograph takes the frame whatever size the words are.
     * Searching: the picture's own name lives in the catalogue, not here.
     * Mirroring: a paired screen reads a local file path off another machine's
     * disk, so the picture cannot cross and a caption is all there is to send.
     */
    case "figure":
      return component.caption ?? "";
  }
}

export interface Display {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
  inUse: boolean;
}

export interface ProjectorState {
  open: boolean;
  display: number | null;
}

export const getLive = () => invoke<LiveContent | null>("get_live");

export const setLive = (content: LiveContent | null) =>
  invoke<void>("set_live", { content });

export const listDisplays = () => invoke<Display[]>("list_displays");

export const openProjector = (display?: number) =>
  invoke<ProjectorState>("open_projector", { display: display ?? null });

export const closeProjector = () => invoke<ProjectorState>("close_projector");

export const projectorState = () => invoke<ProjectorState>("projector_state");

/**
 * A second congregation-facing display.
 *
 * The same view, the same theme and the same content as the projector, on a
 * screen the operator chooses — an overflow room, a foyer, a second hall. It
 * renders from the same component rather than a copy of it, so the two cannot
 * drift apart, and it is opened and closed independently because a church may
 * want one, the other, or both.
 */
export interface SecondState {
  open: boolean;
  display: number | null;
}

export const openSecond = (display?: number) =>
  invoke<SecondState>("open_second", { display: display ?? null });

export const closeSecond = () => invoke<SecondState>("close_second");

export const secondState = () => invoke<SecondState>("second_state");

export const onLive = (
  handler: (content: LiveContent | null) => void,
): Promise<UnlistenFn> =>
  listen<LiveContent | null>(EVENT_LIVE, (event) => handler(event.payload));

/**
 * How loud a clip plays, and whether it plays at all.
 *
 * Kept in Rust for the same reason as the live content: the projector and the
 * operator's pane must not disagree about what the congregation is hearing.
 */
export interface AudioState {
  muted: boolean;
  /** 0 to 1. */
  volume: number;
}

export const EVENT_AUDIO = "audio:changed";

export const getAudio = () => invoke<AudioState>("get_audio");

export const setAudio = (audio: AudioState) =>
  invoke<AudioState>("set_audio", { audio });

export const onAudio = (
  handler: (audio: AudioState) => void,
): Promise<UnlistenFn> =>
  listen<AudioState>(EVENT_AUDIO, (event) => handler(event.payload));

/** A band of text crawling across the screen, over whatever is live. */
export interface Ticker {
  text: string;
  visible: boolean;
  /** Its own colour: the band sits on a scrim, not on the background. */
  textColor: string;
  bandColor: string;
  /** 0 to 1. Zero leaves the words floating on whatever is behind them. */
  bandOpacity: number;
  /** "top" or "bottom". */
  position: "top" | "bottom";
  /** Seconds for one pass across the screen. Larger is slower. */
  speed: number;
}

export const EVENT_TICKER = "ticker:changed";

export const getTicker = () => invoke<Ticker>("get_ticker");

export const setTicker = (ticker: Ticker) =>
  invoke<Ticker>("set_ticker", { ticker });

export const onTicker = (
  handler: (ticker: Ticker) => void,
): Promise<UnlistenFn> =>
  listen<Ticker>(EVENT_TICKER, (event) => handler(event.payload));

/** What the operator has asked the clip to do. Both surfaces obey it. */
export interface MediaCommand {
  playing: boolean;
  looping: boolean;
  /**
   * Bumped whenever a jump is asked for. A bare position could not express it:
   * "back to the start" twice running is two instructions, not one.
   */
  seekNonce: number;
  seekTo: number;
}

/** Where the clip has reached, reported by whichever surface is the output. */
export interface MediaProgress {
  position: number;
  duration: number;
  ended: boolean;
}

export const EVENT_MEDIA = "media:command";
export const EVENT_MEDIA_PROGRESS = "media:progress";

export const getMedia = () => invoke<MediaCommand>("get_media");

export const setMedia = (command: MediaCommand) =>
  invoke<MediaCommand>("set_media", { command });

export const getMediaProgress = () =>
  invoke<MediaProgress>("get_media_progress");

export const reportMediaProgress = (progress: MediaProgress) =>
  invoke<void>("report_media_progress", { progress });

export const onMedia = (
  handler: (command: MediaCommand) => void,
): Promise<UnlistenFn> =>
  listen<MediaCommand>(EVENT_MEDIA, (event) => handler(event.payload));

export const onMediaProgress = (
  handler: (progress: MediaProgress) => void,
): Promise<UnlistenFn> =>
  listen<MediaProgress>(EVENT_MEDIA_PROGRESS, (event) =>
    handler(event.payload),
  );
