import { useState } from "react";

import type { SongRights, SongSection } from "../lib/catalog";
import {
  LINE_CHOICES,
  rememberLines,
  screensOf,
  storedLines,
  type LinesPerScreen,
} from "../lib/lyrics";
import type { ProjectorTheme } from "../lib/theme";
import { SlideCanvas } from "./SlideCanvas";
import { TypeControls } from "./TypeControls";

const FIELD =
  "w-full rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

const BUTTON =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12.5px] text-pulpitry-text transition-colors hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring";

/**
 * Writing a song, and seeing how it will break.
 *
 * # Why this is a screen rather than a panel
 *
 * Because three things have to be visible at once and none of them is small:
 * the words being typed, what one screenful will look like on the wall, and
 * the whole run of screenfuls the song turns into. A church typing in "You
 * Make Me Brave" wants to know it comes out as thirty-two screens and that
 * none of them is a single orphaned line — and that is a fact about the song
 * as a whole, which a preview of one part cannot tell them.
 *
 * # A song is words, not slides
 *
 * The left column is a plain text box, because that is what a song is: labels
 * and lines, the way it appears in every hymnal, every other presentation
 * program's export, and every lyric sheet a worship leader has ever been sent.
 * Pasting one in should work, and it does.
 *
 * The right column is what those words *become* at the current setting, and it
 * is recalculated as they are typed. Nothing here is stored: the song keeps the
 * writer's own lines, and the breaking is done when it is staged. Changing
 * "2 lines" to "4 lines" changes every song and edits none of them.
 */
export function SongEditor({
  title: initialTitle,
  author: initialAuthor,
  sections: initialSections,
  rights: initialRights,
  theme,
  onTheme,
  onSave,
  onClose,
  parse,
  toText,
}: {
  title: string;
  author: string;
  sections: SongSection[];
  rights: SongRights;
  theme: ProjectorTheme;
  /** Changing how words are set: the church's look, not this song's. */
  onTheme: (theme: ProjectorTheme) => void;
  onSave: (song: {
    title: string;
    author: string;
    sections: SongSection[];
    rights: SongRights;
  }) => void;
  onClose: () => void;
  /** The library's own parser, so what is typed here is read as it is there. */
  parse: (text: string) => SongSection[];
  toText: (sections: SongSection[]) => string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState(initialAuthor);
  const [rights, setRights] = useState(initialRights);
  const [text, setText] = useState(() => toText(initialSections));
  const [lines, setLines] = useState<LinesPerScreen>(storedLines);
  const [at, setAt] = useState(0);

  const sections = parse(text);
  const screens = screensOf(sections, lines);
  const showing = screens[Math.min(at, Math.max(0, screens.length - 1))];

  return (
    <div data-dialog className="fixed inset-0 z-50 flex flex-col bg-pulpitry-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-pulpitry-line bg-pulpitry-surface px-3">
        <span className="min-w-0 flex-1 truncate text-[15px] text-pulpitry-text">
          {title.trim() || "New song"}
          {author.trim() ? (
            <span className="ml-2 text-[12px] text-pulpitry-muted">
              — {author.trim()}
            </span>
          ) : null}
        </span>
        <button type="button" onClick={onClose} className={BUTTON}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!title.trim()}
          onClick={() =>
            onSave({ title: title.trim(), author: author.trim(), sections, rights })
          }
          title={title.trim() ? "Keep this song" : "A title is needed first"}
          className="rounded bg-pulpitry-gold px-3.5 py-2 text-[13px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
        >
          Save song
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.85fr)_minmax(0,1.4fr)_minmax(260px,0.8fr)] gap-0">
        {/* The words. */}
        <div className="flex min-h-0 flex-col gap-2 overflow-auto border-r border-pulpitry-line p-3">
          <label className="block">
            <span className="mb-1 block text-[11px] tracking-wide text-pulpitry-muted uppercase">
              Song title
            </span>
            <input
              value={title}
              autoFocus={!initialTitle}
              placeholder="What the operator will look for"
              onChange={(event) => setTitle(event.target.value)}
              className={FIELD}
            />
          </label>

          <div className="flex gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] tracking-wide text-pulpitry-muted uppercase">
                Author
              </span>
              <input
                value={author}
                placeholder="Who wrote it"
                onChange={(event) => setAuthor(event.target.value)}
                className={FIELD}
              />
            </label>
            <label className="w-[7.5rem] shrink-0">
              <span className="mb-1 block text-[11px] tracking-wide text-pulpitry-muted uppercase">
                CCLI
              </span>
              {/* The church's own song number, kept for their reporting and
                  sent nowhere. Pulpitry does not integrate CCLI: it is a
                  licence they hold, not a service an application can call. */}
              <input
                value={rights.ccli}
                placeholder="Number"
                onChange={(event) =>
                  setRights({ ...rights, ccli: event.target.value })
                }
                className={FIELD}
              />
            </label>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <span className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] tracking-wide text-pulpitry-muted uppercase">
                Lyrics
              </span>
              {/* Beside the words, because the answer to "how many lines" is
                  judged against them: a verse of long lines wants fewer. */}
              <select
                value={lines}
                aria-label="Lines on a screen"
                onChange={(event) => {
                  const next = Number(event.target.value) as LinesPerScreen;
                  setLines(next);
                  rememberLines(next);
                  setAt(0);
                }}
                className="rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-1 text-[11px] text-pulpitry-text outline-none focus-visible:focus-ring"
              >
                {LINE_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </span>
            <p className="mb-1 text-[11px] text-pulpitry-muted">
              A label or a blank line starts a part.
            </p>
            <textarea
              value={text}
              placeholder={
                "Verse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n\nChorus\n…"
              }
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              className={`${FIELD} min-h-[16rem] flex-1 resize-none font-mono text-[12px] leading-relaxed`}
            />
          </div>
        </div>

        {/* One screenful, on the church's own look. */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
          <span className="shrink-0 text-[11px] tracking-wide text-pulpitry-muted uppercase">
            On the screen
          </span>

          {/*
            The real renderer on the real theme, which is not the same as
            treating a song as a slide: what a congregation reads is these
            words in this typeface at this size, and the only way to know
            whether two lines fit is to draw them.
          */}
          <SlideCanvas
            blocks={[]}
            body={{ kind: "lyric", lines: showing?.lines ?? [] }}
            theme={theme}
          />

          <p className="text-[11.5px] leading-relaxed text-pulpitry-muted">
            {screens.length === 0
              ? "Type the words and they appear here as the congregation will read them."
              : `${screens.length} ${screens.length === 1 ? "screen" : "screens"} from ${sections.length} ${sections.length === 1 ? "part" : "parts"}. The song keeps your own lines — the breaking happens when it is put on screen, so changing this changes every song and edits none of them.`}
          </p>

          {/* How the words are set, against the words themselves. It is the
              church's look and says so -- see TypeControls. */}
          <TypeControls theme={theme} onChange={onTheme} />

          <RightsFields rights={rights} onChange={setRights} />
        </div>

        {/* What it turns into, all of it. */}
        <div className="flex min-h-0 flex-col border-l border-pulpitry-line">
          <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-pulpitry-line px-3 py-2">
            <span className="text-[11px] tracking-wide text-pulpitry-muted uppercase">
              Screens
            </span>
            <span className="text-[11px] text-pulpitry-muted tabular-nums">
              {screens.length}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {screens.map((screen, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setAt(index)}
                className={`w-full rounded border px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                  index === at
                    ? "border-pulpitry-teal bg-pulpitry-teal-dim"
                    : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
                }`}
              >
                <span className="block text-[10.5px] tracking-[0.08em] text-pulpitry-muted uppercase">
                  {screen.label || `Part ${index + 1}`}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-pulpitry-text">
                  {screen.lines.map((line, line_at) => (
                    <span key={line_at} className="block truncate">
                      {line}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Where the words came from and on what terms.
 *
 * Kept beside the words rather than behind a button: the question is easiest to
 * answer at the moment somebody has the source in front of them, and hardest
 * six months later when a licence is being reported.
 */
function RightsFields({
  rights,
  onChange,
}: {
  rights: SongRights;
  onChange: (rights: SongRights) => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded border border-pulpitry-line p-2.5">
      <label className="block">
        <span className="mb-1 block text-[11px] tracking-wide text-pulpitry-muted uppercase">
          May these words go on a screen?
        </span>
        <select
          value={rights.status}
          onChange={(event) =>
            onChange({
              ...rights,
              status: event.target.value as SongRights["status"],
            })
          }
          className={FIELD}
        >
          <option value="unknown">Nobody has checked</option>
          <option value="publicDomain">Public domain</option>
          <option value="licensed">Covered by our licence</option>
          <option value="restricted">Not covered</option>
        </select>
      </label>

      <div className="flex gap-2">
        <input
          value={rights.author}
          placeholder="Words by"
          onChange={(event) => onChange({ ...rights, author: event.target.value })}
          className={FIELD}
        />
        {/* Separate because words and tune expire separately, and only the
            words are what this application reproduces. */}
        <input
          value={rights.composer}
          placeholder="Tune by"
          onChange={(event) =>
            onChange({ ...rights, composer: event.target.value })
          }
          className={FIELD}
        />
      </div>

      <input
        value={rights.source}
        placeholder="Where the words came from"
        onChange={(event) => onChange({ ...rights, source: event.target.value })}
        className={FIELD}
      />
    </div>
  );
}
