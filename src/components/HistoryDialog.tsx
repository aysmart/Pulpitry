import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "./Markdown";
import { describeError, generateSlides, type DraftSlide } from "../lib/api";
import { catalogSave } from "../lib/catalog";
import { componentsFor } from "./SlidesFromSermon";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  exportSummary,
  getSession,
  importSession,
  listSessions,
  removeSession,
  retitleSession,
  searchSessions,
  sessionLines,
  summariseSession,
  summaryAvailable,
  type Line,
  type Session,
  type SummaryFormat,
} from "../lib/history";

/**
 * Past services.
 *
 * Called that rather than "History", which the library already uses for the
 * verses shown so far. Two Histories meaning two different things is worse
 * than a longer label.
 *
 * Two panes, because the two things people do here are different: finding the
 * week they mean, and reading it. Finding is a list and a search box; reading
 * is a summary, then the transcript underneath for when the summary is not
 * enough.
 */

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Session length as something readable, from the timestamps we have. */
function describeLength(session: Session): string {
  if (!session.endedAt) return "still recording";
  const minutes = Math.round((session.endedAt - session.startedAt) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

/** `1:04:22` from the offset a line was spoken at. */
function offset(atMs: number): string {
  const total = Math.max(0, Math.floor(atMs / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const stamp = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${stamp}` : stamp;
}

const FORMATS: { id: SummaryFormat; label: string }[] = [
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "Word" },
  { id: "text", label: "Text" },
  { id: "markdown", label: "Markdown" },
];

export function HistoryDialog({
  onClose,
  engine,
}: {
  onClose: () => void;
  /** Which engine is selected, because it decides what to advise. */
  engine: string;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const [canSummarise, setCanSummarise] = useState(false);
  const [slides, setSlides] = useState<DraftSlide[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [makingSlides, setMakingSlides] = useState(false);
  const [keptSlides, setKeptSlides] = useState(0);
  const [summarising, setSummarising] = useState(false);
  /**
   * What the summary is doing, while it is doing it.
   *
   * A four-hour service is read in several parts, any of which may wait out a
   * busy model, so this runs for minutes. Silence for that long reads as a
   * hang, and the operator's response to a hang is to press the button again --
   * which starts a second set of requests and lengthens the queue the first is
   * waiting in.
   */
  const [progress, setProgress] = useState<string | null>(null);
  const [exporting, setExporting] = useState<SummaryFormat | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    void summaryAvailable().then(setCanSummarise).catch(() => setCanSummarise(false));
  }, []);

  // The search runs in SQLite, so it is asked for rather than filtered here:
  /**
   * Adds a service from a transcript file the church already has.
   *
   * A transcript that was recorded before Pulpitry, taken down by hand, or
   * exported from a service that has since been deleted. It lands as an
   * ordinary past service, so summarising, exporting and slides all work on it
   * exactly as they do on one that was heard live.
   */
  const addFromFile = useCallback(async () => {
    setImportError(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Transcript", extensions: ["txt", "md", "text"] }],
    });
    // Cancelling is not a failure and needs no message.
    if (typeof picked !== "string") return;

    setImporting(true);
    try {
      const added = await importSession(picked);
      setSessions((current) => [added, ...current.filter((s) => s.id !== added.id)]);
      setSelectedId(added.id);
      setQuery("");
    } catch (error) {
      setImportError(describeError(error));
    } finally {
      setImporting(false);
    }
  }, []);

  // the transcript being searched is far larger than the list being shown.
  const search = query.trim();
  useEffect(() => {
    let active = true;
    const run = () =>
      (search ? searchSessions(search) : listSessions())
        .then((found) => {
          if (!active) return;
          setSessions(found);
          // Keep the open service open if it survived the search; otherwise
          // show the first result rather than an empty pane.
          setSelectedId((current) =>
            current && found.some((session) => session.id === current)
              ? current
              : (found[0]?.id ?? null),
          );
        })
        .catch((err) => active && setError(describeError(err)));

    // Typing a phrase should not run a query per keystroke.
    const timer = setTimeout(run, search ? 200 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search]);

  useEffect(() => {
    if (!selectedId) {
      setLines([]);
      return;
    }
    let active = true;
    setLoadingLines(true);
    setConfirmDelete(false);
    void sessionLines(selectedId)
      .then((found) => active && setLines(found))
      .catch((err) => active && setError(describeError(err)))
      .finally(() => active && setLoadingLines(false));
    return () => {
      active = false;
    };
  }, [selectedId]);

  // The title box follows the selection, except while it is being typed in.
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setTitle(selected?.title ?? "");
  }, [selected]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const replace = useCallback((next: Session) => {
    setSessions((current) =>
      current.map((session) => (session.id === next.id ? next : session)),
    );
  }, []);

  const commitTitle = useCallback(async () => {
    editing.current = false;
    const trimmed = title.trim();
    if (!selected || trimmed === selected.title) return;
    try {
      await retitleSession(selected.id, trimmed);
      replace({ ...selected, title: trimmed });
    } catch (err) {
      setError(describeError(err));
      setTitle(selected.title);
    }
  }, [selected, title, replace]);

  const summarise = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setProgress(null);
    setSummarising(true);
    try {
      const described = await summariseSession(selected.id);
      // Read back rather than merged from the reply: the store is what the
      // exports will use, and it is the one that has to be right.
      const fresh = await getSession(selected.id);
      replace(fresh ?? { ...selected, ...described });
      setTitle(described.title);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSummarising(false);
      setProgress(null);
    }
  }, [selected, replace]);

  // Reported from the Rust side as each part is read; see EVENT_SUMMARY_PROGRESS.
  useEffect(() => {
    const unlisten = listen<string>("summary-progress", (event) =>
      setProgress(event.payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  /*
   * Slides from a service already preached.
   *
   * The same gesture as Summarise and beside it, because it is the same
   * question asked twice: what was this about, and what would it look like on a
   * wall. A church that recorded last Sunday and wants slides for the repeat at
   * the evening service should not have to copy a transcript out of one dialog
   * and paste it into another.
   *
   * Nothing is saved until each one is kept, exactly as when an outline is
   * pasted in fresh -- the rule is about a model writing into a library
   * unread, and it does not become safer because the words came from a
   * transcript.
   */
  const makeSlides = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setMakingSlides(true);
    setSlides(null);
    setKeptSlides(0);
    try {
      const lines = await sessionLines(selected.id);
      const transcript = lines.map((line) => line.text).join(" ");
      setSlides(await generateSlides(transcript));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setMakingSlides(false);
    }
  }, [selected]);

  /**
   * Keeps the whole set, named after the service it came from.
   *
   * A group like a song, for the reason the other entry point gives: they were
   * made together and are used in order. Here the name is already known — it is
   * the service's own title — so nobody is asked for one.
   */
  const keepSlides = useCallback(async () => {
    if (!selected || !slides || slides.length === 0) return;
    setError(null);
    try {
      await catalogSave({
        id: null,
        title: selected.title || "Sermon slides",
        subtitle: `${slides.length} slide${slides.length === 1 ? "" : "s"}`,
        body: {
          kind: "deck",
          /*
           * The same section a sermon's slides get, built the same way.
           *
           * This was its own copy: label and lines, no components. Every table
           * the model produced was discarded here, by the path an operator
           * actually uses -- while the other copy, which I had carefully taught
           * to carry them, is reached from a screen nobody was on.
           *
           * `componentsFor` is imported rather than repeated so there is one
           * answer to what a slide is made of.
           */
          sections: slides.map((draft) => ({
            label: draft.title || "Slide",
            lines: [...draft.lines, ...(draft.reference ? [draft.reference] : [])],
            components: componentsFor(draft),
            layout: "stacked" as const,
          })),
        },
        path: null,
        updatedAt: Date.now(),
      });
      setKeptSlides(slides.length);
      setSlides(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [selected, slides]);

  const write = useCallback(
    async (format: SummaryFormat) => {
      if (!selected) return;
      setError(null);
      setExporting(format);
      try {
        const path = await exportSummary(selected, format);
        // Cancelling the save dialog is not a failure and needs no message.
        if (path) setNotice(`Saved to ${path}`);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setExporting(null);
      }
    },
    [selected],
  );

  const remove = useCallback(async () => {
    if (!selected) return;
    try {
      await removeSession(selected.id);
      setSessions((current) => {
        const rest = current.filter((session) => session.id !== selected.id);
        setSelectedId(rest[0]?.id ?? null);
        return rest;
      });
      setConfirmDelete(false);
    } catch (err) {
      setError(describeError(err));
    }
  }, [selected]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Past services"
        aria-modal="true"
        className="flex h-full max-h-full w-full max-w-[1040px] flex-col rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-pulpitry-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] text-pulpitry-text">Past services</h2>
            <p className="text-[11.5px] text-pulpitry-muted">
              Every service is saved as it is transcribed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addFromFile}
              disabled={importing}
              title="Add a past service from a transcript file"
              className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-muted disabled:opacity-50 focus-visible:focus-ring"
            >
              {importing ? "Adding…" : "Add from file…"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-muted focus-visible:focus-ring"
            >
              Close
            </button>
          </div>
        </header>

        {importError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-pulpitry-line bg-pulpitry-raised px-5 py-2 text-[12px] text-pulpitry-gold"
          >
            {importError}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,290px)_1fr]">
          {/* The list. */}
          <div className="flex min-h-0 flex-col border-r border-pulpitry-line">
            <div className="shrink-0 p-3">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search what was said…"
                aria-label="Search transcripts"
                className="w-full rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
              {sessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12.5px] leading-relaxed text-pulpitry-muted">
                  {search
                    ? "Nothing recorded matches that."
                    : "Nothing here yet. Start listening and the service will be saved as it goes."}
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {sessions.map((session) => {
                    const active = session.id === selectedId;
                    return (
                      <li key={session.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(session.id)}
                          aria-current={active}
                          className={`w-full rounded border px-2.5 py-2 text-left transition-colors focus-visible:focus-ring ${
                            active
                              ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                              : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                          }`}
                        >
                          <span
                            className={`block truncate text-[13px] ${
                              active ? "text-pulpitry-gold" : "text-pulpitry-text"
                            }`}
                          >
                            {session.title || "Untitled service"}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-pulpitry-muted tabular-nums">
                            {dayFormat.format(new Date(session.startedAt))} ·{" "}
                            {timeFormat.format(new Date(session.startedAt))}
                          </span>
                          <span className="text-[11px] text-pulpitry-muted">
                            {session.wordCount.toLocaleString()} words · {describeLength(session)}
                            {session.summary ? " · summarised" : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* The service. */}
          <div className="flex min-h-0 flex-col">
            {!selected ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <p className="max-w-[34ch] text-[13px] leading-relaxed text-pulpitry-muted">
                  Choose a service to read it, summarise it, or export it.
                </p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                <input
                  value={title}
                  onChange={(event) => {
                    editing.current = true;
                    setTitle(event.target.value);
                  }}
                  onBlur={() => void commitTitle()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      editing.current = false;
                      setTitle(selected.title);
                      event.currentTarget.blur();
                    }
                  }}
                  placeholder="Untitled service"
                  aria-label="Title"
                  className="w-full rounded border border-transparent bg-transparent px-2 py-1 text-[17px] text-pulpitry-text outline-none transition-colors hover:border-pulpitry-line focus:border-pulpitry-line focus:bg-pulpitry-raised focus-visible:focus-ring"
                />
                <p className="px-2 text-[11.5px] text-pulpitry-muted">
                  {dayFormat.format(new Date(selected.startedAt))} ·{" "}
                  {timeFormat.format(new Date(selected.startedAt))} ·{" "}
                  {selected.wordCount.toLocaleString()} words · {describeLength(selected)}
                </p>

                {/* What it was about. */}
                {/* Slides from what was said, beside the summary and asked for
                    the same way. A church recording the morning and repeating
                    it in the evening should not have to copy a transcript out
                    of one dialog and into another. */}
                {canSummarise ? (
                  <section className="mt-4 rounded-md border border-pulpitry-line bg-pulpitry-raised/40 px-4 py-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-[11px] tracking-[0.14em] text-pulpitry-teal uppercase">
                        Slides
                      </h3>
                      <button
                        type="button"
                        onClick={() => void makeSlides()}
                        disabled={makingSlides}
                        className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1 text-[11.5px] text-pulpitry-text transition-colors hover:border-pulpitry-muted disabled:opacity-50 focus-visible:focus-ring"
                      >
                        {makingSlides ? "Reading the transcript…" : "Make slides"}
                      </button>
                    </div>

                    {keptSlides > 0 ? (
                      <p className="mt-2 text-[12px] text-pulpitry-muted">
                        Kept {keptSlides} slide{keptSlides === 1 ? "" : "s"} as one set.
                      </p>
                    ) : null}

                    {slides?.length === 0 ? (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-pulpitry-muted">
                        Nothing here made slides. It was told to return nothing rather than
                        invent something.
                      </p>
                    ) : null}

                    {slides && slides.length > 0 ? (
                      <div className="mt-3 flex flex-col gap-2">
                        {slides.map((draft, index) => (
                          <div
                            key={`${draft.title}-${index}`}
                            className="rounded border border-pulpitry-line px-3 py-2"
                          >
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="text-[13px] text-pulpitry-text">
                                {draft.title || "Untitled"}
                              </span>
                              {draft.reference ? (
                                <span className="shrink-0 text-[11px] text-pulpitry-teal">
                                  {draft.reference}
                                </span>
                              ) : null}
                            </div>
                            {/* A comparison is the slide, so it is shown as one.
                                Without this a table slide reads as a bare title
                                and looks broken -- which is exactly how it was
                                reported. */}
                            {draft.table ? (
                              <table className="mt-1.5 w-full border-collapse text-left text-[11.5px] text-pulpitry-muted">
                                <thead>
                                  <tr>
                                    {draft.table.header.map((cell, at) => (
                                      <th
                                        key={at}
                                        scope="col"
                                        className="border-b border-pulpitry-line pr-3 pb-1 font-semibold text-pulpitry-text"
                                      >
                                        {cell}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {draft.table.rows.map((row, at) => (
                                    <tr key={at}>
                                      {row.map((cell, index) => (
                                        <td key={index} className="pr-3 pt-1 align-top">
                                          {cell}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : null}

                            {draft.lines.length > 0 ? (
                              <ul className="mt-1 flex flex-col gap-0.5 text-[12px] leading-snug text-pulpitry-muted">
                                {draft.lines.map((line, at) => (
                                  <li key={at}>{line}</li>
                                ))}
                              </ul>
                            ) : null}

                            {/* What the preacher said, under the slide it became. */}
                            {draft.anchor ? (
                              <p className="mt-1.5 border-l-2 border-pulpitry-teal-dim pl-2 text-[10px] leading-[1.45] text-pulpitry-muted/80 italic">
                                “{draft.anchor.length > 140
                                  ? `${draft.anchor.slice(0, 140).trimEnd()}…`
                                  : draft.anchor}”
                              </p>
                            ) : null}
                            <button
                              type="button"
                              onClick={() =>
                                setSlides((current) =>
                                  current?.filter((_, at) => at !== index) ?? null,
                                )
                              }
                              className="mt-2 rounded px-2.5 py-1 text-[11.5px] text-pulpitry-muted underline-offset-2 hover:underline focus-visible:focus-ring"
                            >
                              Discard
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => void keepSlides()}
                          className="mt-1 self-start rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text focus-visible:focus-ring"
                        >
                          Keep {slides.length} as a set
                        </button>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <section className="mt-4 rounded-md border border-pulpitry-line bg-pulpitry-raised/40 px-4 py-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[11px] tracking-[0.14em] text-pulpitry-teal uppercase">
                      Summary
                    </h3>
                    {canSummarise ? (
                      <button
                        type="button"
                        onClick={() => void summarise()}
                        disabled={summarising}
                        className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1 text-[11.5px] text-pulpitry-text transition-colors hover:border-pulpitry-muted disabled:opacity-50 focus-visible:focus-ring"
                      >
                        {summarising
                          ? (progress ?? "Reading the transcript…")
                          : selected.summary
                            ? "Summarise again"
                            : "Summarise"}
                      </button>
                    ) : null}
                  </div>

                  {!canSummarise && !selected.summary ? (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-pulpitry-muted">
                      {engine === "hosted"
                        ? // Nothing to buy: the assistant comes with the plan.
                          "Summaries are written by the assistant, which is included in your Castavox subscription. Activate this machine under Settings → Transcription and this will offer to title and summarise each service."
                        : "Summaries are written by the assistant. Add a model endpoint and key under Settings → Model assistance, and this will offer to title and summarise each service."}
                    </p>
                  ) : selected.summary ? (
                    <>
                      <Markdown source={selected.summary} className="mt-3" />

                      {selected.topics.length > 0 ? (
                        <div className="mt-4 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] tracking-[0.14em] text-pulpitry-muted uppercase">
                            Subjects
                          </span>
                          {selected.topics.map((topic) => (
                            <span
                              key={topic}
                              className="rounded-full border border-pulpitry-line px-2 py-0.5 text-[11.5px] text-pulpitry-muted"
                            >
                              {topic}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-pulpitry-line pt-3">
                        <span className="mr-1 text-[11.5px] text-pulpitry-muted">Export as</span>
                        {FORMATS.map((format) => (
                          <button
                            key={format.id}
                            type="button"
                            onClick={() => void write(format.id)}
                            disabled={exporting !== null}
                            className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1 text-[11.5px] text-pulpitry-text transition-colors hover:border-pulpitry-muted disabled:opacity-50 focus-visible:focus-ring"
                          >
                            {exporting === format.id ? "Saving…" : format.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-pulpitry-muted">
                      {summarising
                        ? (progress
                            ? `${progress} A long service is read in parts, and the model may keep us waiting between them.`
                            : "Reading the transcript. On a long service this takes a moment.")
                        : "Not summarised yet. The assistant will title it, say what was taught, and list the subjects raised."}
                    </p>
                  )}
                </section>

                {/* What was said. */}
                <section className="mt-5">
                  <h3 className="text-[11px] tracking-[0.14em] text-pulpitry-muted uppercase">
                    Transcript
                  </h3>
                  {loadingLines ? (
                    <p className="mt-2 text-[12.5px] text-pulpitry-muted">Loading…</p>
                  ) : lines.length === 0 ? (
                    <p className="mt-2 text-[12.5px] text-pulpitry-muted">
                      Nothing was recognised in this service.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-col gap-2" data-selectable>
                      {lines.map((line, index) => (
                        <p
                          key={index}
                          className="text-[13px] leading-relaxed text-pulpitry-text"
                        >
                          <span className="mr-2 select-none text-[11px] text-pulpitry-muted tabular-nums">
                            {offset(line.atMs)}
                          </span>
                          {line.text}
                        </p>
                      ))}
                    </div>
                  )}
                </section>

                <div className="mt-6 flex items-center gap-2 border-t border-pulpitry-line pt-3">
                  {confirmDelete ? (
                    <>
                      <span className="text-[12px] text-pulpitry-muted">
                        Delete this service and its transcript?
                      </span>
                      <button
                        type="button"
                        onClick={() => void remove()}
                        className="rounded border border-pulpitry-gold-dim bg-pulpitry-gold/10 px-2.5 py-1 text-[11.5px] text-pulpitry-gold transition-colors hover:bg-pulpitry-gold/20 focus-visible:focus-ring"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="rounded px-2.5 py-1 text-[11.5px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                      >
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="rounded px-2.5 py-1 text-[11.5px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                    >
                      Delete this service
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* A fixed height here meant a long message drew straight over the
            transcript behind it. It wraps now, and is bounded: anything longer
            than three lines is not a sentence an operator was going to read. */}
        <footer
          aria-live="polite"
          className="flex min-h-8 shrink-0 items-start border-t border-pulpitry-line px-5 py-1.5 text-[11.5px]"
        >
          <span
            title={error ?? notice ?? undefined}
            className={`line-clamp-3 leading-snug ${
              error ? "text-pulpitry-gold" : "text-pulpitry-muted"
            }`}
          >
            {error ?? notice ?? ""}
          </span>
        </footer>
      </div>
    </div>
  );
}
