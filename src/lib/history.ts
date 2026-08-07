import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

/**
 * Past services.
 *
 * Every session is written down as it is recognised, so nothing depends on the
 * operator remembering to export before closing the app. This is how the app
 * reads them back.
 */

/** One recorded service, without its lines. */
export interface Session {
  id: number;
  /** Unix milliseconds. */
  startedAt: number;
  /** Absent while it is still being recorded. */
  endedAt: number | null;
  title: string;
  /** Markdown. Empty until the assistant has been asked. */
  summary: string;
  topics: string[];
  wordCount: number;
}

/** One settled utterance, offset from the start of its session. */
export interface Line {
  atMs: number;
  text: string;
}

/** What the assistant made of a service. */
export interface Description {
  title: string;
  /** Markdown. */
  summary: string;
  topics: string[];
}

export const listSessions = (limit?: number) => invoke<Session[]>("history_list", { limit });

export const searchSessions = (query: string, limit?: number) =>
  invoke<Session[]>("history_search", { query, limit });

export const getSession = (id: number) => invoke<Session | null>("history_get", { id });

export const sessionLines = (id: number) => invoke<Line[]>("history_lines", { id });

export const retitleSession = (id: number, title: string) =>
  invoke<void>("history_retitle", { id, title });

export const removeSession = (id: number) => invoke<void>("history_remove", { id });

/** Whether the assistant is set up well enough to be offered. */
export const summaryAvailable = () => invoke<boolean>("summary_available");

/** Asks the model what a service was about, and stores what comes back. */
export const summariseSession = (id: number) =>
  invoke<Description>("summarise_session", { id });

/** The formats a summary can be written in. */
export type SummaryFormat = "markdown" | "text" | "docx" | "pdf";

const EXTENSION: Record<SummaryFormat, { extension: string; name: string }> = {
  markdown: { extension: "md", name: "Markdown" },
  text: { extension: "txt", name: "Text" },
  docx: { extension: "docx", name: "Word document" },
  pdf: { extension: "pdf", name: "PDF" },
};

/** A file name that sorts by date and says what it is. */
export function summaryFileName(session: Session, format: SummaryFormat): string {
  const date = new Date(session.startedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  // Punctuation a file system would object to, or that makes a name awkward to
  // type, becomes a hyphen. Never empty, because a name of ".pdf" is hidden.
  const slug =
    session.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "summary";
  return `${stamp}-${slug}.${EXTENSION[format].extension}`;
}

/**
 * Asks where to put a summary and writes it there.
 *
 * @returns the path written, or null if the operator cancelled.
 */
export async function exportSummary(
  session: Session,
  format: SummaryFormat,
): Promise<string | null> {
  const { extension, name } = EXTENSION[format];
  const path = await save({
    title: "Export summary",
    defaultPath: summaryFileName(session, format),
    filters: [{ name, extensions: [extension] }],
  });
  if (!path) return null;

  await invoke<number>("export_summary", { id: session.id, path, format });
  return path;
}
