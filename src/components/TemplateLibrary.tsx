import { useCallback, useEffect, useState } from "react";

import {
  catalogList,
  catalogRemove,
  catalogSave,
  newItem,
  type Item,
} from "../lib/catalog";
import {
  SAMPLE_TEMPLATES,
  TEMPLATE_GROUPS,
  TEMPLATE_SAMPLE,
} from "../lib/templates";
import { DEFAULT_THEME, type ProjectorTheme } from "../lib/theme";
import { DisplaySettings } from "./DisplaySettings";
import { SlideCanvas } from "./SlideCanvas";

const sample = TEMPLATE_SAMPLE as Parameters<typeof SlideCanvas>[0]["blocks"];

/** A template is a whole look, so a swatch would not tell you what you get. */
function Tile({
  name,
  hint,
  theme,
  current,
  onApply,
  onEdit,
  onRemove,
}: {
  name: string;
  hint: string;
  theme: ProjectorTheme;
  current: boolean;
  onApply: () => void;
  onEdit: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="group relative flex flex-col gap-1">
      <button
        type="button"
        onClick={onApply}
        title={hint}
        className="block text-left focus-visible:focus-ring"
      >
        <span
          className={`block rounded ${current ? "ring-2 ring-pulpitry-gold" : ""}`}
        >
          <SlideCanvas blocks={sample} theme={theme} />
        </span>
        <span
          className={`mt-1.5 block truncate text-[12.5px] ${
            current ? "text-pulpitry-gold" : "text-pulpitry-text"
          }`}
        >
          {name}
          {current ? " · in use" : ""}
        </span>
        {/* What it is for, which is what an operator actually chooses by:
            "built for a camera", "for a hall with sun in it". There was no
            room for it at tile size and it lived in a tooltip. */}
        <span className="block truncate text-[11px] text-pulpitry-muted">
          {hint}
        </span>
      </button>

      <span className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${name}`}
          title={onRemove ? `Edit ${name}` : `Start a theme from ${name}`}
          className="rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[11px] text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
        >
          {onRemove ? "Edit" : "Copy"}
        </button>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${name}`}
            className="rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[12px] leading-none text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
          >
            ×
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The look of the projector, shown as looks rather than as settings.
 *
 * A theme is eight controls that only make sense together, and no operator
 * picks a typeface and an outline width by reasoning about them. They pick the
 * one that reads well in their room — which means they have to see it. Each
 * tile is the real renderer on the real theme, so the tile is the answer.
 *
 * Samples ship read-only; anything the operator saves sits beside them and can
 * be deleted.
 *
 * The editor has two exits because there are two things people want. Use puts
 * a change on the projector now and forgets it, which is the mid-service tweak
 * that used to live in the settings dialog. Save also keeps it, which is what
 * building a look for next week means.
 */
export function TemplateLibrary({
  theme,
  deskLabel,
  onApply,
  onClose,
  onError,
}: {
  theme: ProjectorTheme;
  /** Which desk this look is for, because each desk keeps its own. */
  deskLabel: string;
  onApply: (theme: ProjectorTheme) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [saved, setSaved] = useState<Item[]>([]);
  const [editing, setEditing] = useState<{
    id: number | null;
    name: string;
    theme: ProjectorTheme;
  } | null>(null);

  const fail = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  const refresh = useCallback(async () => {
    try {
      setSaved(await catalogList("template"));
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!editing) return;
    const title = editing.name.trim();
    if (!title) return;
    try {
      // Saving under an existing name replaces it, rather than leaving two
      // templates the operator cannot tell apart.
      const existing =
        saved.find((item) => item.id === editing.id) ??
        saved.find((item) => item.title.toLowerCase() === title.toLowerCase());
      await catalogSave(
        existing
          ? {
              ...existing,
              title,
              body: { kind: "template", theme: editing.theme },
            }
          : newItem(title, { kind: "template", theme: editing.theme }),
      );
      // Putting it straight on the projector: nobody builds a look in order to
      // not use it, and leaving the old one up reads as the save having failed.
      onApply(editing.theme);
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

  // Compared by value: a template applied and then nudged in Settings is no
  // longer the one in use, and saying otherwise would be a small lie. Keys are
  // sorted first — a plain stringify would quietly depend on Rust and
  // TypeScript declaring the fields in the same order.
  const stable = (candidate: ProjectorTheme) =>
    JSON.stringify(
      Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
    );
  const current = stable(theme);
  const isCurrent = (candidate: ProjectorTheme) =>
    stable(candidate) === current;

  if (editing) {
    return (
      <div
        data-dialog
        className="fixed inset-0 z-50 flex flex-col bg-pulpitry-ink"
      >
        <div className="flex shrink-0 gap-1.5 border-b border-pulpitry-line px-3 py-2.5">
          <input
            value={editing.name}
            placeholder="Name this theme"
            autoFocus
            aria-label="Theme name"
            onChange={(event) =>
              setEditing({ ...editing, name: event.target.value })
            }
            className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editing.name.trim()}
            title={
              editing.name.trim()
                ? "Keep it, and put it on the projector"
                : "Name it first"
            }
            className="rounded bg-pulpitry-gold px-2.5 py-1.5 text-[12.5px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(editing.theme);
              setEditing(null);
            }}
            title="Put it on the projector without keeping it"
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
          >
            Use
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
          >
            Cancel
          </button>
        </div>

        <div className="mx-auto min-h-0 w-full max-w-[64rem] flex-1 overflow-auto p-4">
          {/* The whole point of an editor here rather than in a dialog: every
              change lands on a full-size render of the real thing. */}
          <SlideCanvas blocks={sample} theme={editing.theme} />

          <div className="mt-3">
            <DisplaySettings
              theme={editing.theme}
              onChange={(next) => setEditing({ ...editing, theme: next })}
              onError={onError}
              showThemesHint={false}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    /*
      A screen rather than a pane.
      
      A look is chosen by seeing it, and a tile the width of a sidebar shows a
      typeface as a grey smudge -- which is how a church ends up choosing by
      name and finding out on Sunday. At this size each one is a screen: the
      real renderer, the real typeface, the real background, drawn at the
      proportions of the wall it will be on.
      
      It is also the one job here nobody does during a service, so taking the
      window costs nothing.
    */
    <div data-dialog className="fixed inset-0 z-50 flex flex-col bg-pulpitry-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-pulpitry-line bg-pulpitry-surface px-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] text-pulpitry-text">Looks</span>
          {/* Which desk, because each keeps its own: choosing here sets how the
              songs read, and leaves the scripture desk alone. */}
          <span className="block text-[11.5px] text-pulpitry-muted">
            For the {deskLabel.toLowerCase()} desk — click one to use it
          </span>
        </span>
        {/*
          Three ways in, and they are genuinely different starting points.
          
          Adjust opens on whatever is on the projector now, which is the
          mid-service tweak. Copy, on a tile, opens on that theme. New opens on
          the defaults -- and that was the one missing: an operator building a
          look for their own room had to begin from somebody else's and undo it,
          which is a worse starting point than a blank one and reads as though
          starting fresh were not allowed.
        */}
        <button
          type="button"
          onClick={() =>
            setEditing({ id: null, name: "", theme: DEFAULT_THEME })
          }
          title="Start a theme from the defaults"
          className="shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
        >
          New
        </button>
        <button
          type="button"
          onClick={() => setEditing({ id: null, name: "", theme })}
          title="Change the look in use, keeping it or not"
          className="shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
        >
          Adjust
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
        >
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {saved.length > 0 ? (
          <>
            <p className="mb-2 text-[11px] tracking-wide text-pulpitry-muted uppercase">
              Yours
            </p>
            <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
              {saved.map((item) =>
                item.body.kind === "template" ? (
                  <Tile
                    key={item.id}
                    name={item.title}
                    /* The shipped looks carry what they are for as their
                       subtitle — "built for a camera", "for a hall with sun in
                       it" — which is what an operator chooses by. A theme the
                       church made itself has none, so it keeps the plain
                       wording. */
                    hint={item.subtitle.trim() || `Apply ${item.title}`}
                    theme={item.body.theme}
                    current={isCurrent(item.body.theme)}
                    onApply={() =>
                      item.body.kind === "template" && onApply(item.body.theme)
                    }
                    onEdit={() =>
                      item.body.kind === "template" &&
                      setEditing({
                        id: item.id,
                        name: item.title,
                        theme: item.body.theme,
                      })
                    }
                    onRemove={() => item.id !== null && void remove(item.id)}
                  />
                ) : null,
              )}
            </div>
          </>
        ) : null}

        {TEMPLATE_GROUPS.map((group) => (
          <section key={group} className="mb-5 last:mb-0">
            <p className="mb-2 text-[11px] tracking-wide text-pulpitry-muted uppercase">
              {group}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-3">
              {SAMPLE_TEMPLATES.filter((preset) => preset.group === group).map(
                (preset) => (
                  <Tile
                    key={preset.id}
                    name={preset.name}
                    hint={preset.hint}
                    theme={preset.theme}
                    current={isCurrent(preset.theme)}
                    onApply={() => onApply(preset.theme)}
                    onEdit={() =>
                      setEditing({
                        id: null,
                        name: preset.name,
                        theme: preset.theme,
                      })
                    }
                  />
                ),
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
