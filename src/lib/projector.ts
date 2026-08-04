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
export type LiveBody =
  | { kind: "scripture"; lines: ScriptureLine[] }
  | { kind: "lyric"; lines: string[] }
  | { kind: "richText"; blocks: TextBlock[] }
  | { kind: "image"; path: string }
  | { kind: "media"; path: string; looping: boolean };

export interface LiveContent {
  body: LiveBody;
  /** Shown small beneath: a reference, a song title, or nothing. */
  caption: string;
  /** Verse ids behind this, so lists can highlight what is live. */
  ids: number[];
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
    default:
      return "";
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

export const setLive = (content: LiveContent | null) => invoke<void>("set_live", { content });

export const listDisplays = () => invoke<Display[]>("list_displays");

export const openProjector = (display?: number) =>
  invoke<ProjectorState>("open_projector", { display: display ?? null });

export const closeProjector = () => invoke<ProjectorState>("close_projector");

export const projectorState = () => invoke<ProjectorState>("projector_state");

export const onLive = (handler: (content: LiveContent | null) => void): Promise<UnlistenFn> =>
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

export const setAudio = (audio: AudioState) => invoke<AudioState>("set_audio", { audio });

export const onAudio = (handler: (audio: AudioState) => void): Promise<UnlistenFn> =>
  listen<AudioState>(EVENT_AUDIO, (event) => handler(event.payload));
