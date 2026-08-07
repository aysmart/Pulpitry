import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Markdown } from "./Markdown";
import { describeError } from "../lib/api";
import {
  exportSummary,
  getSession,
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

export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [loadingLines, setLoadingLines] = useState(false);
  const [canSummarise, setCanSummarise] = useState(false);
  const [summarising, setSummarising] = useState(false);
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
    }
  }, [selected, replace]);

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
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-muted focus-visible:focus-ring"
          >
            Close
          </button>
        </header>

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
                          ? "Reading the transcript…"
                          : selected.summary
                            ? "Summarise again"
                            : "Summarise"}
                      </button>
                    ) : null}
                  </div>

                  {!canSummarise && !selected.summary ? (
                    <p className="mt-2 text-[12.5px] leading-relaxed text-pulpitry-muted">
                      Summaries are written by the assistant. Add a model endpoint and key under
                      Settings → Assistant, and this will offer to title and summarise each
                      service.
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
                        ? "Reading the transcript. On a long service this takes a moment."
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

        <footer
          aria-live="polite"
          className="flex h-8 shrink-0 items-center border-t border-pulpitry-line px-5 text-[11.5px]"
        >
          <span className={error ? "text-pulpitry-gold" : "text-pulpitry-muted"}>
            {error ?? notice ?? ""}
          </span>
        </footer>
      </div>
    </div>
  );
}
