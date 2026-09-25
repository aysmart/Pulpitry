import { useCallback, useEffect, useRef, useState } from "react";

import { catalogList, catalogRemove, catalogSave, newItem, type Item } from "../lib/catalog";
import {
  DECK_TEMPLATES,
  describeTemplate,
  type DeckTemplate,
} from "../lib/deckTemplates";
import { elementsText } from "../lib/design";
import { componentText, type LiveBody, type TextBlock } from "../lib/projector";
import { blankDeck, DeckEditor } from "./DeckEditor";
import { presentableFor } from "../lib/schedule";
import type { ProjectorTheme } from "../lib/theme";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";
import { useKeepInView } from "../lib/useKeepInView";
import { SlideCanvas } from "./SlideCanvas";

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring";

const TOOL =
  "rounded border border-pulpitry-line px-1.5 py-0.5 text-[11px] text-pulpitry-muted transition-colors hover:border-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring";

const ON = "border-pulpitry-gold-dim text-pulpitry-gold";

const ALIGNMENTS = ["left", "center", "right"] as const;

function blankBlock(): TextBlock {
  return { text: "", level: "body", align: "center", bold: false, italic: false };
}

/** Which shelf of the library is showing. */
type Shelf = "all" | "mine" | "templates";

/**
 * What a card draws, which is the real slide and not an impression of one.
 *
 * A composed slide -- anything with components, which is every generated deck
 * and every shipped template -- has to be drawn as one: from `blocks` alone a
 * table arrives as a run of words, so the card would misrepresent the slide it
 * is offering.
 */
function thumbnailOf(item: Item): { blocks: TextBlock[]; body?: LiveBody } {
  if (item.body.kind === "slide") {
    return item.body.components && item.body.components.length > 0
      ? {
          blocks: [],
          body: {
            kind: "composed",
            components: item.body.components,
            layout: item.body.layout ?? "stacked",
          },
        }
      : { blocks: item.body.blocks };
  }

  if (item.body.kind === "deck") {
    // The first slide, because that is what a deck looks like from outside.
    const first = item.body.sections[0];
    // Laid out by hand, and drawn that way here: a card showing the lines a
    // designed slide grew from would advertise a slide nobody has.
    if (first?.elements && first.elements.length > 0) {
      return {
        blocks: [],
        body: {
          kind: "designed",
          elements: first.elements,
          background: item.body.background ?? null,
        },
      };
    }
    if (first?.components && first.components.length > 0) {
      return {
        blocks: [],
        body: {
          kind: "composed",
          components: first.components,
          layout: first.layout ?? "stacked",
        },
      };
    }
    return { blocks: [], body: { kind: "lyric", lines: first?.lines ?? [] } };
  }

  return { blocks: [] };
}

/** "3 slides · Service", or "1 slide" where nothing has said what kind. */
function describeItem(item: Item): string {
  const count = item.body.kind === "deck" ? item.body.sections.length : 1;
  const slides = `${count} ${count === 1 ? "slide" : "slides"}`;
  return item.subtitle.trim() ? `${slides} · ${item.subtitle.trim()}` : slides;
}

/** Everything written on a deck or slide, for the search to look through. */
function textOf(item: Item): string {
  const parts = [item.title, item.subtitle];
  if (item.body.kind === "slide") {
    parts.push(...item.body.blocks.map((block) => block.text));
    parts.push(...(item.body.components ?? []).map(componentText));
  }
  if (item.body.kind === "deck") {
    for (const section of item.body.sections) {
      parts.push(section.label, ...section.lines);
      parts.push(...(section.components ?? []).map(componentText));
      // What a designed slide actually says, so searching finds the deck by
      // the words on it rather than by whatever it used to say.
      if (section.elements) parts.push(elementsText(section.elements));
    }
  }
  return parts.join(" ").toLowerCase();
}

function templateText(template: DeckTemplate): string {
  return [
    template.title,
    template.category,
    ...template.sections.flatMap((section) => [
      section.label,
      ...section.lines,
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Slides the operator writes themselves: a welcome, a notice, a title card.
 *
 * Text is held as a closed set of fields rather than markup. Rich text from an
 * editor would have to be sanitised before the projector could show it, and
 * getting that wrong is a real hazard; these blocks cannot carry markup at all.
 */
export function SlideLibrary({
  theme,
  translation,
  onPreview,
  previewKey,
  liveKey,
  keyOf,
  onError,
}: {
  theme: ProjectorTheme;
  /** Which Bible a verse placed on a designed slide is read from. */
  translation: string;
  /**
   * Stages an item. `andShow` puts it on screen in the same gesture — a
   * double-click, for when the operator already knows what they want there.
   */
  onPreview: (item: Presentable, andShow?: boolean) => void;
  previewKey: string | null;
  liveKey: string | null;
  keyOf: (item: Presentable) => string;
  onError: (message: string) => void;
}) {
  const [slides, setSlides] = useState<Item[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  /*
   * What is staged and what is live, kept in view as they move -- from the
   * plan, a voice command -- rather than marked below the fold. See
   * lib/useKeepInView.ts.
   */
  useKeepInView(scroller, "live", liveKey);
  useKeepInView(scroller, "preview", previewKey);
  const [shelf, setShelf] = useState<Shelf>("all");
  const [query, setQuery] = useState("");
  /** The deck open in the designer, if any. */
  const [designing, setDesigning] = useState<Item | null>(null);
  /** The template being copied, so one press cannot make two decks. */
  const [using, setUsing] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: number | null;
    title: string;
    blocks: TextBlock[];
  } | null>(null);
  // Formatting applies to the line being written, so one toolbar serves them
  // all rather than repeating six controls on every row.
  const [focused, setFocused] = useState(0);

  const fail = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  const refresh = useCallback(async () => {
    try {
      // Sets first, then loose slides. A sermon's slides are kept as one item
      // and this is where somebody looks for them -- listing only the loose
      // ones would make a kept sermon invisible in the place it was saved to.
      const [decks, loose] = await Promise.all([catalogList("deck"), catalogList("slide")]);
      setSlides([...decks, ...loose]);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    if (!title) return;
    // Empty lines are spacing while writing but nothing on a screen.
    const blocks = editing.blocks.filter((block) => block.text.trim().length > 0);
    try {
      const item: Item = {
        ...(editing.id === null
          ? newItem(title, { kind: "slide", blocks })
          : { id: editing.id, title, subtitle: "", body: { kind: "slide", blocks }, path: null, updatedAt: 0 }),
      };
      await catalogSave(item);
      setEditing(null);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (id: number) => {
    try {
      await catalogRemove(id);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  /**
   * Takes a shipped template and makes it the church's own deck.
   *
   * Copied rather than staged where it stands, which is the whole design of
   * these templates: ours are read-only and always present, and the act of
   * using one is the act of acquiring it. From here it is an ordinary deck —
   * it appears under Mine, it can be edited, and it can be deleted without
   * costing anybody the template.
   *
   * It is staged in the same gesture, because nobody chooses a template in
   * order not to use it.
   */
  const use = async (template: DeckTemplate) => {
    /*
     * One copy per press, whatever the hand did.
     *
     * Every other card in this window answers a double-click by going live, so
     * hands arrive here already double-clicking -- and without this guard the
     * second click starts a second save before the first has returned, both see
     * the same set of titles, and the church ends up with two decks of the same
     * name from one gesture.
     */
    if (using) return;
    setUsing(template.id);
    try {
      // A second "Sunday service" would be two cards the operator cannot tell
      // apart on the Sunday they need one of them.
      const taken = new Set(slides.map((item) => item.title.toLowerCase()));
      let title = template.title;
      for (let n = 2; taken.has(title.toLowerCase()); n += 1) {
        title = `${template.title} ${n}`;
      }

      const saved = await catalogSave({
        ...newItem(title, { kind: "deck", sections: template.sections }),
        subtitle: template.category,
      });
      await refresh();
      const staged = presentableFor(saved);
      if (staged) onPreview(staged);
    } catch (err) {
      fail(err);
    } finally {
      setUsing(null);
    }
  };

  /*
   * Laying a deck out, in a screen of its own.
   *
   * Full-screen rather than inside this panel: positioning elements needs the
   * window, and it is the one job in Pulpitry that is not done during a service
   * -- so it is the one place where taking the whole window costs nothing. The
   * fixed strip's Go live and Clear stay reachable by closing it, which is one
   * press.
   */
  if (designing) {
    return (
      <DeckEditor
        item={designing}
        theme={theme}
        translation={translation}
        onClose={() => setDesigning(null)}
        onSaved={(saved) => {
          setDesigning(null);
          void refresh();
          // Staged, not sent: saving a deck is finishing it, and the operator
          // decides when a congregation sees it.
          const staged = presentableFor(saved);
          if (staged) onPreview(staged);
        }}
        onError={onError}
      />
    );
  }

  const needle = query.trim().toLowerCase();
  const mine = slides.filter(
    (item) => !needle || textOf(item).includes(needle),
  );
  const templates = DECK_TEMPLATES.filter(
    (template) => !needle || templateText(template).includes(needle),
  );
  const showMine = shelf !== "templates";
  const showTemplates = shelf !== "mine";
  const found =
    (showMine ? mine.length : 0) + (showTemplates ? templates.length : 0);

  if (editing) {
    const update = (index: number, change: Partial<TextBlock>) =>
      setEditing({
        ...editing,
        blocks: editing.blocks.map((block, at) =>
          at === index ? { ...block, ...change } : block,
        ),
      });
    const current = editing.blocks[focused];

    return (
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2">
        <input
          value={editing.title}
          placeholder="Title — how you will find it later"
          autoFocus
          onChange={(event) => setEditing({ ...editing, title: event.target.value })}
          className={FIELD}
        />

        <SlideCanvas blocks={editing.blocks} theme={theme} />

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() =>
              update(focused, { level: current?.level === "heading" ? "body" : "heading" })
            }
            className={`${TOOL} ${current?.level === "heading" ? ON : ""}`}
            title="Larger, for the line that carries the slide"
          >
            Heading
          </button>
          <button
            type="button"
            onClick={() => update(focused, { bold: !current?.bold })}
            className={`${TOOL} ${current?.bold ? ON : ""}`}
            aria-label="Bold"
          >
            <span className="font-semibold">B</span>
          </button>
          <button
            type="button"
            onClick={() => update(focused, { italic: !current?.italic })}
            className={`${TOOL} ${current?.italic ? ON : ""}`}
            aria-label="Italic"
          >
            <span className="italic">I</span>
          </button>
          {ALIGNMENTS.map((align) => (
            <button
              key={align}
              type="button"
              onClick={() => update(focused, { align })}
              className={`${TOOL} ${current?.align === align ? ON : ""}`}
              aria-label={`Align ${align}`}
            >
              {align === "left" ? "◧" : align === "center" ? "▣" : "◨"}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-pulpitry-muted">
            Line {focused + 1}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          {editing.blocks.map((block, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                value={block.text}
                placeholder={index === 0 ? "Welcome" : "Another line"}
                aria-label={`Line ${index + 1}`}
                onFocus={() => setFocused(index)}
                onChange={(event) => update(index, { text: event.target.value })}
                className={`min-w-0 flex-1 ${FIELD} ${
                  focused === index ? "border-pulpitry-teal" : ""
                }`}
              />
              <button
                type="button"
                onClick={() => {
                  setEditing({
                    ...editing,
                    blocks: editing.blocks.filter((_, at) => at !== index),
                  });
                  setFocused((at) => Math.max(0, at > index ? at - 1 : at));
                }}
                disabled={editing.blocks.length === 1}
                aria-label={`Remove line ${index + 1}`}
                className="shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-pulpitry-muted hover:text-pulpitry-text disabled:opacity-30 focus-visible:focus-ring"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setEditing({ ...editing, blocks: [...editing.blocks, blankBlock()] });
            setFocused(editing.blocks.length);
          }}
          className={`${TOOL} self-start`}
        >
          Add line
        </button>

        <p className="text-[11px] text-pulpitry-muted">
          {editing.title.trim()
            ? "Shown exactly as above, on the projector theme in Settings."
            : "Give it a title to save."}
        </p>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editing.title.trim()}
            title={editing.title.trim() ? "Save this slide" : "A title is needed first"}
            className="flex-1 rounded bg-pulpitry-gold px-3 py-1.5 text-[12.5px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        Search first, then which shelf.

        A church with forty decks finds one by typing a word off it -- the
        search reads titles and the words on the slides, because "the one with
        the bank details on it" is how somebody remembers a deck they made in
        March. The shelves answer a different question: whether they are looking
        at their own work or at something we shipped.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-pulpitry-line px-2.5 py-2">
        <input
          value={query}
          spellCheck={false}
          data-search
          placeholder="Search decks, templates and slide text…"
          aria-label="Search the slide library"
          onChange={(event) => setQuery(event.target.value)}
          className={`min-w-[8rem] flex-1 ${FIELD}`}
        />

        <div
          role="group"
          aria-label="Which decks to show"
          className="flex items-center gap-0.5 rounded border border-pulpitry-line bg-pulpitry-raised p-0.5"
        >
          {(
            [
              ["all", "All", "Everything in the library"],
              ["mine", "Mine", "Decks and slides this church has made"],
              ["templates", "Templates", "Decks that ship with Pulpitry"],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              type="button"
              title={hint}
              aria-pressed={shelf === id}
              onClick={() => setShelf(id)}
              className={`rounded px-2 py-1 text-[11.5px] transition-colors focus-visible:focus-ring ${
                shelf === id
                  ? "bg-pulpitry-teal-dim text-pulpitry-text"
                  : "text-pulpitry-muted hover:text-pulpitry-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="text-[11px] text-pulpitry-muted tabular-nums">
          {found}
        </span>
      </div>

      {found === 0 && needle ? (
        <EmptyState>Nothing in the library matches “{query}”.</EmptyState>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-2">
          {showMine ? (
            <>
              {shelf === "all" && templates.length > 0 ? (
                <p className="mb-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase">
                  Yours
                </p>
              ) : null}
              <div className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] content-start gap-2">
                {/*
                  A blank page, first and always.

                  It was a New button in the corner, which is the same act
                  described rather than offered. As a tile it sits where the eye
                  already is -- among the things it would become -- and an empty
                  library reads as a library with one thing in it rather than as
                  a wall with a button beside it.
                */}
                {!needle ? (
                  <button
                    type="button"
                    onClick={() => setDesigning(blankDeck())}
                    title="Lay a deck out yourself: words, verses, shapes and pictures"
                    className="group flex flex-col gap-1 text-left focus-visible:focus-ring"
                  >
                    <span
                      className="flex items-center justify-center rounded border border-dashed border-pulpitry-line text-[20px] leading-none text-pulpitry-muted transition-colors group-hover:border-pulpitry-gold-dim group-hover:text-pulpitry-gold"
                      style={{ aspectRatio: 16 / 9 }}
                    >
                      +
                    </span>
                    <span className="block truncate text-[11px] text-pulpitry-text">
                      Blank deck
                    </span>
                    <span className="block truncate text-[10.5px] text-pulpitry-muted">
                      Start with one page
                    </span>
                  </button>
                ) : null}

                {mine.map((item) => {
                  const staged = presentableFor(item);
                  const key = staged ? keyOf(staged) : "";
                  const state =
                    key === liveKey
                      ? "live"
                      : key === previewKey
                        ? "preview"
                        : "idle";
                  const thumbnail = thumbnailOf(item);

                  return (
                    <div
                      key={item.id}
                      data-live={state === "live"}
                      data-preview={state === "preview"}
                      className="group relative flex flex-col gap-1"
                    >
                      <button
                        type="button"
                        onClick={() => staged && onPreview(staged)}
                        onDoubleClick={() => staged && onPreview(staged, true)}
                        title={`${item.title} — click to stage, double-click to put it on screen`}
                        className="block text-left focus-visible:focus-ring"
                      >
                        <span
                          className={`block rounded ${
                            state === "live"
                              ? "ring-2 ring-pulpitry-gold"
                              : state === "preview"
                                ? "ring-2 ring-pulpitry-teal"
                                : ""
                          }`}
                        >
                          <SlideCanvas
                            blocks={thumbnail.blocks}
                            body={thumbnail.body}
                            theme={theme}
                          />
                        </span>
                        <span className="mt-1 block truncate text-[11px] text-pulpitry-text">
                          {item.title}
                        </span>
                        {/* What it is, under what it is called: how many
                            slides, and what kind of thing it is for. */}
                        <span className="block truncate text-[10.5px] text-pulpitry-muted">
                          {describeItem(item)}
                        </span>
                      </button>

                      <span className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
                        {/* Two editors, because there are two kinds of thing
                            here. A deck opens in the designer; a single slide
                            written before the designer existed keeps the
                            line-by-line editor it was made in, which is still
                            the quickest way to type a notice. */}
                        <button
                          type="button"
                          onClick={() => {
                            if (item.body.kind === "deck") {
                              setDesigning(item);
                              return;
                            }
                            if (item.body.kind === "slide") {
                              setFocused(0);
                              setEditing({
                                id: item.id,
                                title: item.title,
                                blocks:
                                  item.body.blocks.length > 0
                                    ? item.body.blocks
                                    : [blankBlock()],
                              });
                            }
                          }}
                          className="rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[11px] text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => item.id !== null && void remove(item.id)}
                          aria-label={`Remove ${item.title}`}
                          className="rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[12px] leading-none text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>

              {mine.length === 0 && !needle ? (
                <p className="mb-3 px-1 text-[11.5px] leading-relaxed text-pulpitry-muted">
                  Nothing of your own yet. Start from a template below, or write
                  a page on the blank tile.
                </p>
              ) : null}
            </>
          ) : null}

          {showTemplates ? (
            <>
              {shelf === "all" ? (
                <p className="mb-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase">
                  Templates
                </p>
              ) : null}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] content-start gap-2">
                {templates.map((template) => {
                  const first = template.sections[0];
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => void use(template)}
                      disabled={using !== null}
                      title={`${template.hint}. Adds a copy to your decks.`}
                      className="group flex flex-col gap-1 text-left disabled:opacity-60 focus-visible:focus-ring"
                    >
                      <span className="block rounded ring-pulpitry-teal group-hover:ring-2">
                        <SlideCanvas
                          blocks={[]}
                          body={
                            first?.components && first.components.length > 0
                              ? {
                                  kind: "composed",
                                  components: first.components,
                                  layout: first.layout ?? "stacked",
                                }
                              : { kind: "lyric", lines: first?.lines ?? [] }
                          }
                          theme={theme}
                        />
                      </span>
                      <span className="block truncate text-[11px] text-pulpitry-text">
                        {template.title}
                      </span>
                      <span className="block truncate text-[10.5px] text-pulpitry-muted">
                        {describeTemplate(template)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
