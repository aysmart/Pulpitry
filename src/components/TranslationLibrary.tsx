import { useCallback, useEffect, useState } from "react";

import {
  installTranslation,
  onTranslationProgress,
  removeTranslation,
  translationLibrary,
  type Offered,
} from "../lib/bible";
import { describeError } from "../lib/api";

/**
 * Bytes at the precision the number is being used at.
 *
 * A pack is between one and two megabytes, and rounding that to whole
 * megabytes turns every translation into "1 MB" — a column of identical
 * numbers, which is the same as no column at all.
 */
function size(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The order languages appear in.
 *
 * English first because it is what most of the catalogue is and what the
 * application defaults to; everything else alphabetically after it. Not sorted
 * by size or by count — a church looks for a language by name.
 */
function order(languages: string[]): string[] {
  const rest = languages.filter((l) => l !== "English" && l !== "").sort();
  return [
    ...(languages.includes("English") ? ["English"] : []),
    ...rest,
    ...(languages.includes("") ? [""] : []),
  ];
}

/**
 * The scripture library: what this church reads, and what else it could.
 *
 * # Why a translation is downloaded rather than shipped
 *
 * All 22 texts fit in 28 MB, so this was never about the size of the
 * installer. It is about the 442 MB a church ends up holding once those texts
 * are unpacked, indexed for word search and — for the ones anybody searches by
 * meaning — indexed again at 65 MB apiece. A library is the screen where that
 * becomes a choice instead of a number in a disk usage panel.
 *
 * # Why the states are words
 *
 * "Installed", "1.3 MB to add", "Downloading, 43%". A church laptop at the back
 * of a hall is not somewhere a green dot is legible, and a volunteer who has
 * used this twice should not have to have learnt what our colours mean.
 */
export function TranslationLibrary({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<Offered[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Per-translation percentage while it downloads. */
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await translationLibrary());
      setProblem(null);
    } catch (err) {
      // The pane above still lists what is installed, because that came from
      // the database. What is lost here is the list of things a download would
      // be needed for, which is exactly what a hall with no internet cannot do
      // anyway.
      setProblem(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = onTranslationProgress((progress) => {
      if (progress.done) {
        setBusy((current) => {
          const next = { ...current };
          delete next[progress.id];
          return next;
        });
        void refresh();
        onChange();
        return;
      }
      const percent =
        progress.total > 0
          ? Math.round((progress.received / progress.total) * 100)
          : 0;
      setBusy((current) => ({ ...current, [progress.id]: percent }));
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [refresh, onChange]);

  const install = async (row: Offered) => {
    setNote(null);
    setBusy((current) => ({ ...current, [row.id]: 0 }));
    try {
      await installTranslation(row.id);
    } catch (err) {
      setBusy((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      setNote(describeError(err));
    }
  };

  const remove = async (row: Offered) => {
    setNote(null);
    try {
      await removeTranslation(row.id);
      await refresh();
      onChange();
    } catch (err) {
      setNote(describeError(err));
    }
  };

  if (!rows) {
    return (
      <p className="text-[12px] text-pulpitry-muted">
        {problem ?? "Reading the library…"}
      </p>
    );
  }

  const installed = rows.filter((row) => row.installed).length;
  const languages = order([...new Set(rows.map((row) => row.language))]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[11.5px] text-pulpitry-muted">
        {installed} of {rows.length} installed. A translation is about a
        megabyte to download and stays on this machine until you remove it.
      </p>

      {problem && (
        <p className="text-[11.5px] text-pulpitry-muted">
          {problem} What is already installed is listed below and works as it
          always did.
        </p>
      )}

      {note && <p className="text-[11.5px] text-pulpitry-gold">{note}</p>}

      {languages.map((language) => (
        <section key={language || "other"} className="flex flex-col gap-1">
          {/* Ranged left under a hanging rule — the same device the slide
              arrangements use. A settings screen full of little icons is the
              most generic thing in desktop software. */}
          <h4 className="border-t border-pulpitry-line pt-2 text-[11px] tracking-[0.14em] text-pulpitry-muted uppercase">
            {language || "Already installed"}
          </h4>

          {rows
            .filter((row) => row.language === language)
            /* By the code, because the code is the column the eye runs down.
               The catalogue's own order is the order translations were added
               to it, which is a fact about us and not about what somebody is
               looking for. */
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((row) => {
              const percent = busy[row.id];
              const downloading = percent !== undefined;
              return (
                <div
                  key={row.id}
                  className="flex items-baseline gap-3 py-1.5 text-[13px]"
                >
                  <span className="w-16 shrink-0 font-medium text-pulpitry-text tabular-nums">
                    {row.id}
                  </span>
                  <span className="min-w-0 flex-1 text-pulpitry-text">
                    {row.name}
                    {row.year > 0 && (
                      <span className="text-pulpitry-muted"> · {row.year}</span>
                    )}
                    {/* Under the name rather than behind a hover or an icon.
                        Somebody deciding whether to spend a download on this
                        translation is reading this line at the moment the
                        answer matters, and "the Old Testament is four books"
                        is not a footnote to that decision. */}
                    {row.note && (
                      <span className="block text-[11.5px] leading-snug text-pulpitry-muted">
                        {row.note}
                      </span>
                    )}
                  </span>

                  {downloading ? (
                    <span className="shrink-0 text-[12px] text-pulpitry-muted tabular-nums">
                      Downloading, {percent}%
                    </span>
                  ) : row.installed ? (
                    <>
                      <span className="shrink-0 text-[12px] text-pulpitry-muted">
                        Installed
                      </span>
                      <button
                        type="button"
                        onClick={() => void remove(row)}
                        className="shrink-0 text-[12px] text-pulpitry-muted underline-offset-2 hover:text-pulpitry-text hover:underline focus-visible:focus-ring"
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="shrink-0 text-[12px] text-pulpitry-muted tabular-nums">
                        {size(row.bytes)} to add
                      </span>
                      <button
                        type="button"
                        onClick={() => void install(row)}
                        className="shrink-0 rounded border border-pulpitry-line px-2.5 py-1 text-[12px] text-pulpitry-text focus-visible:focus-ring"
                      >
                        Download
                      </button>
                    </>
                  )}
                </div>
              );
            })}
        </section>
      ))}
    </div>
  );
}
