import { invoke } from "@tauri-apps/api/core";

import type { ProjectorTheme } from "./theme";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface Settings {
  azureRegion: string;
  language: string;
  inputDeviceId: string | null;
  /** Verse detection searches this translation. */
  translation: string;

  /**
   * Which recogniser turns audio into words: "azure", "local" or "hosted".
   *
   * Azure streams and needs an account; its free tier is about five hours a
   * month. The local engine runs whisper.cpp on this machine, needs nothing,
   * and is a beat behind because a model cannot transcribe a sentence until
   * it ends. Hosted streams like Azure but on our account, metered against a
   * plan, so a church needs no Azure account at all.
   */
  speechEngine: string;
  /** This machine, to a hosted subscription. Not a secret. */
  hostedDeviceId: string;
  /**
   * Offering what is on the projector to a Castavox on the same wifi.
   *
   * Off unless asked for: it opens a port and announces this machine on the
   * local network, neither of which should happen to a church that never
   * wanted it.
   */
  mirrorEnabled: boolean;
  /** The whisper.cpp model, by file name. Empty until one is chosen. */
  speechModel: string;

  /** Optional Azure AI Foundry model for paraphrase suggestions. */
  assistEnabled: boolean;
  assistEndpoint: string;
  assistModel: string;
  assistApiVersion: string;

  /** Local, offline paraphrase matching against an embedding index. */
  /** Whether this installation sends the once-a-day check-in. Off unless the
   *  operator turned it on. */
  /** Whether to look, once a day, for a newer version. On by default. */
  updateCheck: boolean;
  checkIn: boolean;
  semanticEnabled: boolean;
  /** Cosine similarity a match must reach to be shown, 0 to 1. */
  semanticThreshold: number;

  /** How the congregation-facing window looks. */
  projector: ProjectorTheme;
}

/** One whisper.cpp model the operator could transcribe with. */
export interface SpeechModel {
  /** File name, which is also its identity: "ggml-base.en.bin". */
  file: string;
  /** What to show: "base.en". */
  label: string;
  bytes: number;
  /** The `.en` builds are better at English and cannot do anything else. */
  englishOnly: boolean;
  /** Smaller and faster, at some cost in accuracy. */
  quantised: boolean;
  installed: boolean;
}

/** Progress while a model is fetched. */
export interface ModelProgress {
  file: string;
  received?: number;
  total?: number;
  /** downloading | ready | error */
  state: string;
  error?: string;
}

/**
 * Which models exist and which are here.
 *
 * Asked of whisper.cpp's own repository rather than listed in the app, so it
 * gains new ones without a release. Works offline, reporting what is already
 * downloaded.
 */
export const speechModels = () => invoke<SpeechModel[]>("speech_models");

export const downloadSpeechModel = (file: string) =>
  invoke<void>("download_speech_model", { file });

export interface SettingsView extends Settings {
  hasAzureKey: boolean;
  hasAssistKey: boolean;
  /** Whether this machine has been activated on a hosted subscription. */
  hasHostedSubscription: boolean;
}

/** Mirrors the states the Rust supervisor reports. */
export type SpeechState =
  "idle" | "starting" | "listening" | "reconnecting" | "error";

export interface SpeechStatus {
  state: SpeechState;
  detail: string | null;
  device: string | null;
}

export interface TranscriptPayload {
  text: string;
  offsetMs?: number;
  durationMs?: number;
}

export const EVENT_INTERIM = "transcript:interim";
export const EVENT_FINAL = "transcript:final";
export const EVENT_STATUS = "speech:status";

export const listAudioInputs = () => invoke<AudioDevice[]>("list_audio_inputs");

/** What a hosted plan has left this period. */
export interface EntitlementView {
  status: string;
  /** "12 hr 30 min", worded in castavox-core so both products agree. */
  speechRemaining: string;
  speechSeconds: number;
  usedFraction: number;
  /** The highest warning threshold passed, or null while there is room. */
  warnAt: number | null;
  periodEndsAt: number;
  expiresAt: number | null;
  /** Speech seconds by product, which the pooled quota otherwise hides. */
  byApp: Record<string, number>;
}

export interface HostedView {
  activated: boolean;
  /**
   * Absent when the broker could not be reached, which is not the same as
   * having nothing left. `notice` says which.
   */
  entitlement: EntitlementView | null;
  notice: string | null;
}

export const hostedStatus = () => invoke<HostedView>("hosted_status");
export const hostedActivate = (licence: string) =>
  invoke<HostedView>("hosted_activate", { licence });
export const hostedDeactivate = () => invoke<HostedView>("hosted_deactivate");

export const getSettings = () => invoke<SettingsView>("get_settings");

export const saveSettings = (settings: Settings) =>
  invoke<SettingsView>("save_settings", { settings });

export const saveAzureKey = (key: string) =>
  invoke<void>("save_azure_key", { key });

export const clearAzureKey = () => invoke<void>("clear_azure_key");

export const saveAssistKey = (key: string) =>
  invoke<void>("save_assist_key", { key });

export const clearAssistKey = () => invoke<void>("clear_assist_key");

export const startTranscription = () => invoke<void>("start_transcription");

export const stopTranscription = () => invoke<void>("stop_transcription");

/** Whether the machine has a Node runtime the speech sidecar can use. */
export interface NodeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  /** Node is installed but predates what the sidecar needs. */
  tooOld: boolean;
  minimum: number;
}

export const nodeStatus = () => invoke<NodeStatus>("node_status");

export const speechStatus = () => invoke<SpeechStatus>("speech_status");

export const onInterim = (
  handler: (payload: TranscriptPayload) => void,
): Promise<UnlistenFn> =>
  listen<TranscriptPayload>(EVENT_INTERIM, (event) => handler(event.payload));

export const onFinal = (
  handler: (payload: TranscriptPayload) => void,
): Promise<UnlistenFn> =>
  listen<TranscriptPayload>(EVENT_FINAL, (event) => handler(event.payload));

export const onStatus = (
  handler: (status: SpeechStatus) => void,
): Promise<UnlistenFn> =>
  listen<SpeechStatus>(EVENT_STATUS, (event) => handler(event.payload));

/**
 * What the mirror is doing.
 *
 * The pairing *tokens* are deliberately not here — they are derived secrets and
 * the window has no use for them. What it needs is the names, which is what
 * this carries.
 */
export interface MirrorState {
  enabled: boolean;
  /** The code being offered right now, or empty. */
  code: string;
  watching: number;
  paired: { id: string; name: string }[];
  /** Empty unless something is wrong, in which case it is what to do. */
  problem: string;
}

/**
 * How fast this machine decodes, measured.
 *
 * `factor` is seconds of work per second of audio: below 1.0 is faster than
 * speech, and about 0.3 is comfortable. Zero means it could not be measured —
 * usually a model still downloading — and `detail` says so.
 */
export interface SpeechSpeed {
  factor: number;
  detail: string;
}

export const measureSpeech = () => invoke<SpeechSpeed>("measure_speech");

/**
 * One slide the model proposed, before anybody has approved it.
 *
 * `reference` is a citation and never verse text: Pulpitry holds eleven
 * translations, and a model quoting from memory gets a verse subtly wrong in
 * front of the people most likely to notice.
 */
export interface DraftSlide {
  title: string;
  lines: string[];
  reference: string;
  /**
   * The words in the transcript this slide came from.
   *
   * Checked before it ever arrives — a slide whose anchor is not in the service
   * is dropped on the other side. It is carried here so the operator can see
   * what a slide was made from, which is the difference between approving one
   * and trusting one.
   */
  anchor: string;
  /** A comparison the preacher drew, where they drew one. Usually absent. */
  table: { header: string[]; rows: string[][] } | null;
}

export const generateSlides = (source: string) =>
  invoke<DraftSlide[]>("generate_slides", { source });

export const mirrorState = () => invoke<MirrorState>("mirror_state");
export const mirrorOfferCode = () => invoke<string>("mirror_offer_code");
export const mirrorWithdrawCode = () => invoke<void>("mirror_withdraw_code");
export const mirrorForget = (peerId: string) =>
  invoke<void>("mirror_forget", { peerId });

export const onMirror = (
  handler: (state: MirrorState) => void,
): Promise<UnlistenFn> =>
  listen<MirrorState>("mirror:changed", (event) => handler(event.payload));

/** Tauri surfaces command failures as plain strings. */
export function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
