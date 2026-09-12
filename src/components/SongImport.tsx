import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * A church's existing song library, brought over.
 *
 * # Why this is a sheet and not a setting
 *
 * It happens once. A church arrives with four hundred songs in EasyWorship or
 * OpenLP, and the evening they would otherwise spend retyping is the evening
 * they decide against changing software at all. So it sits beside New in the
 * songs panel, where somebody looking at an empty library will find it, and
 * says plainly where each application keeps the file it wants.
 *
 * # Where the file is
 *
 * The paths are the honest part. An operator who has never looked inside
 * Documents does not know that EasyWorship keeps its songs in
 * Softouch/EasyWorship/Default/Databases/Data, and "choose your library file"
 * is not help. Each row says where to look before it opens the picker.
 */
interface Report {
  added: number;
  duplicates: number;
  failed: number;
}

interface Source {
  kind: string;
  name: string;
  /** What to choose, in the words of that application. */
  what: string;
  /** Where that application puts it. */
  where: string;
  directory: boolean;
  extensions?: string[];
}

const SOURCES: Source[] = [
  {
    kind: "easyworship",
    name: "EasyWorship",
    what: "Its Songs.db file",
    where: "Documents → Softouch → EasyWorship → Default → Databases → Data",
    directory: false,
    extensions: ["db"],
  },
  {
    kind: "openlp",
    name: "OpenLP",
    what: "Its songs.sqlite file",
    where: "The OpenLP data folder, then songs",
    directory: false,
    extensions: ["sqlite", "db"],
  },
  {
    kind: "opensong",
    name: "OpenSong",
    what: "The folder its songs are in",
    where: "OpenSong Data → Songs",
    directory: true,
  },
  {
    kind: "openlyrics",
    name: "OpenLyrics",
    what: "A folder of song files",
    where: "What OpenLP and several other applications export",
    directory: true,
  },
];

export function SongImport({
  onClose,
  onImported,
  onError,
}: {
  onClose: () => void;
  /** Called after anything landed, so the library behind this is re-read. */
  onImported: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<{ source: string; report: Report } | null>(null);

  const run = async (source: Source) => {
    setReport(null);
    let path: string | null = null;
    try {
      const chosen = await open({
        directory: source.directory,
        multiple: false,
        filters: source.extensions
          ? [{ name: `${source.name} library`, extensions: source.extensions }]
          : undefined,
      });
      path = typeof chosen === "string" ? chosen : null;
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      return;
    }
    // Cancelled. Not an error, and not worth a message.
    if (!path) return;

    setBusy(source.kind);
    try {
      const result = await invoke<Report>("import_songs", { kind: source.kind, path });
      setReport({ source: source.name, report: result });
      if (result.added > 0) onImported();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <p className="text-[11.5px] leading-snug text-pulpitry-muted">
        Songs come across with their titles, verses, author, copyright line and
        CCLI number where the file has them. Nothing is sent anywhere, and a
        song already here under the same title is left alone.
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {SOURCES.map((source) => (
          <div
            key={source.kind}
            className="rounded border border-pulpitry-line bg-pulpitry-raised p-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[12.5px] text-pulpitry-text">{source.name}</span>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run(source)}
                className="rounded border border-pulpitry-line px-2.5 py-1 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
              >
                {busy === source.kind ? "Reading…" : "Choose…"}
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-pulpitry-muted">
              {source.what}. {source.where}.
            </p>
          </div>
        ))}
      </div>

      {report ? (
        <p className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[11.5px] leading-snug text-pulpitry-text">
          {describe(report.source, report.report)}
        </p>
      ) : null}

      <p className="text-[11px] leading-snug text-pulpitry-muted">
        Words in an email or a document? Close this and press New — a blank line
        starts a new slide.
      </p>

      <button
        type="button"
        onClick={onClose}
        className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
      >
        Done
      </button>
    </div>
  );
}

/**
 * What happened, in a sentence an operator can act on.
 *
 * Three numbers, and each one means something different: what arrived, what
 * was already here, and what could not be read. Rolling them into "312 songs
 * imported" would hide the only one worth acting on.
 */
function describe(source: string, report: Report): string {
  if (report.added === 0 && report.duplicates === 0 && report.failed === 0) {
    return `Nothing to bring over from ${source}: no songs were found in what you chose.`;
  }

  const parts = [
    report.added === 1 ? "1 song added" : `${report.added} songs added`,
  ];
  if (report.duplicates > 0) {
    parts.push(
      report.duplicates === 1
        ? "1 was already here and was left alone"
        : `${report.duplicates} were already here and were left alone`,
    );
  }
  if (report.failed > 0) {
    parts.push(
      report.failed === 1
        ? "1 could not be read — the log names it"
        : `${report.failed} could not be read — the log names them`,
    );
  }
  return `From ${source}: ${parts.join(", ")}.`;
}
