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
