import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { defaultFileName, formatTranscript, type TranscriptContext } from "./transcriptFile";
import type { TranscriptLine } from "./useTranscript";

export type { TranscriptContext } from "./transcriptFile";

/**
 * Asks for a location and writes the transcript there.
 *
 * @returns the path written, or null if the operator cancelled.
 */
export async function exportTranscript(
  lines: TranscriptLine[],
  context: TranscriptContext = {},
): Promise<string | null> {
  const path = await save({
    title: "Export transcript",
    defaultPath: defaultFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!path) return null;

  await invoke<number>("export_transcript", {
    path,
    contents: formatTranscript(lines, context),
  });
  return path;
}
