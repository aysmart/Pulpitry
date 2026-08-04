import { useCallback, useEffect, useState } from "react";

import { catalogList, catalogRemove, catalogSave, newItem, type Item } from "../lib/catalog";
import { SAMPLE_TEMPLATES, TEMPLATE_GROUPS, TEMPLATE_SAMPLE } from "../lib/templates";
import type { ProjectorTheme } from "../lib/theme";
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
          className={`mt-1 block truncate text-[11px] ${
            current ? "text-pulpitry-gold" : "text-pulpitry-muted"
          }`}
        >
          {name}
          {current ? " · in use" : ""}
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
 */
export function TemplateLibrary({
  theme,
  onApply,
  onError,
}: {
  theme: ProjectorTheme;
  onApply: (theme: ProjectorTheme) => void;
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
          ? { ...existing, title, body: { kind: "template", theme: editing.theme } }
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
    JSON.stringify(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)));
  const current = stable(theme);
  const isCurrent = (candidate: ProjectorTheme) => stable(candidate) === current;

  if (editing) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 gap-1.5 border-b border-pulpitry-line px-2.5 py-2">
          <input
            value={editing.name}
            placeholder="Name this theme"
            autoFocus
            aria-label="Theme name"
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editing.name.trim()}
            title={editing.name.trim() ? "Save it and put it on the projector" : "Name it first"}
            className="rounded bg-pulpitry-gold px-2.5 py-1.5 text-[12.5px] text-pulpitry-ink disabled:opacity-40 focus-visible:focus-ring"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text focus-visible:focus-ring"
          >
            Cancel
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2.5">
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-pulpitry-line px-2.5 py-2">
        <span className="text-[11px] text-pulpitry-muted">
          Click a theme to use it. Copy one to make it yours.
        </span>
        <button
          type="button"
          onClick={() => setEditing({ id: null, name: "", theme })}
          title="Build a theme, starting from the one in use"
          className="shrink-0 rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
        >
          New
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {saved.length > 0 ? (
          <>
            <p className="mb-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase">Yours</p>
            <div className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
              {saved.map((item) =>
                item.body.kind === "template" ? (
                  <Tile
                    key={item.id}
                    name={item.title}
                    hint={`Apply ${item.title}`}
                    theme={item.body.theme}
                    current={isCurrent(item.body.theme)}
                    onApply={() => item.body.kind === "template" && onApply(item.body.theme)}
                    onEdit={() =>
                      item.body.kind === "template" &&
                      setEditing({ id: item.id, name: item.title, theme: item.body.theme })
                    }
                    onRemove={() => item.id !== null && void remove(item.id)}
                  />
                ) : null,
              )}
            </div>
          </>
        ) : null}

        {TEMPLATE_GROUPS.map((group) => (
          <section key={group} className="mb-3 last:mb-0">
            <p className="mb-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase">
              {group}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
              {SAMPLE_TEMPLATES.filter((preset) => preset.group === group).map((preset) => (
                <Tile
                  key={preset.id}
                  name={preset.name}
                  hint={preset.hint}
                  theme={preset.theme}
                  current={isCurrent(preset.theme)}
                  onApply={() => onApply(preset.theme)}
                  onEdit={() => setEditing({ id: null, name: preset.name, theme: preset.theme })}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
