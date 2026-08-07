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
   * Which recogniser turns audio into words: "azure" or "local".
   *
   * Azure streams and needs an account; its free tier is about five hours a
   * month. The local engine runs whisper.cpp on this machine, needs nothing,
   * and is a beat behind because a model cannot transcribe a sentence until
   * it ends.
   */
  speechEngine: string;
  /** The whisper.cpp model, by file name. Empty until one is chosen. */
  speechModel: string;

  /** Optional Azure AI Foundry model for paraphrase suggestions. */
  assistEnabled: boolean;
  assistEndpoint: string;
  assistModel: string;
  assistApiVersion: string;

  /** Local, offline paraphrase matching against an embedding index. */
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
}

/** Mirrors the states the Rust supervisor reports. */
export type SpeechState = "idle" | "starting" | "listening" | "reconnecting" | "error";

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

export const getSettings = () => invoke<SettingsView>("get_settings");

export const saveSettings = (settings: Settings) =>
  invoke<SettingsView>("save_settings", { settings });

export const saveAzureKey = (key: string) => invoke<void>("save_azure_key", { key });

export const clearAzureKey = () => invoke<void>("clear_azure_key");

export const saveAssistKey = (key: string) => invoke<void>("save_assist_key", { key });

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

export const onInterim = (handler: (payload: TranscriptPayload) => void): Promise<UnlistenFn> =>
  listen<TranscriptPayload>(EVENT_INTERIM, (event) => handler(event.payload));

export const onFinal = (handler: (payload: TranscriptPayload) => void): Promise<UnlistenFn> =>
  listen<TranscriptPayload>(EVENT_FINAL, (event) => handler(event.payload));

export const onStatus = (handler: (status: SpeechStatus) => void): Promise<UnlistenFn> =>
  listen<SpeechStatus>(EVENT_STATUS, (event) => handler(event.payload));

/** Tauri surfaces command failures as plain strings. */
export function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
