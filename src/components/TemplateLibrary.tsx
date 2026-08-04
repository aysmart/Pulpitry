import { useCallback, useEffect, useState } from "react";

import { catalogList, catalogRemove, catalogSave, newItem, type Item } from "../lib/catalog";
import { SAMPLE_TEMPLATES, TEMPLATE_SAMPLE } from "../lib/templates";
import type { ProjectorTheme } from "../lib/theme";
import { SlideCanvas } from "./SlideCanvas";

const sample = TEMPLATE_SAMPLE as Parameters<typeof SlideCanvas>[0]["blocks"];

/** A template is a whole look, so a swatch would not tell you what you get. */
function Tile({
  name,
  hint,
  theme,
  current,
  onApply,
  onRemove,
}: {
  name: string;
  hint: string;
  theme: ProjectorTheme;
  current: boolean;
  onApply: () => void;
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

      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute top-1 right-1 hidden rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[12px] leading-none text-pulpitry-muted group-hover:block hover:text-pulpitry-text focus-visible:focus-ring"
        >
          ×
        </button>
      ) : null}
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
  const [name, setName] = useState("");

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
    const title = name.trim();
    if (!title) return;
    try {
      // Saving under an existing name replaces it, rather than leaving two
      // templates the operator cannot tell apart.
      const existing = saved.find((item) => item.title.toLowerCase() === title.toLowerCase());
      await catalogSave(
        existing
          ? { ...existing, body: { kind: "template", theme } }
          : newItem(title, { kind: "template", theme }),
      );
      setName("");
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
  // longer the one in use, and saying otherwise would be a small lie.
  const isCurrent = (candidate: ProjectorTheme) =>
    JSON.stringify(candidate) === JSON.stringify(theme);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex shrink-0 gap-1.5 border-b border-pulpitry-line px-2.5 py-2"
      >
        <input
          value={name}
          placeholder="Save the current look as…"
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          title={name.trim() ? "Save this look" : "Name it first"}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
        >
          Save
        </button>
      </form>

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
                    onRemove={() => item.id !== null && void remove(item.id)}
                  />
                ) : null,
              )}
            </div>
          </>
        ) : null}

        <p className="mb-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase">Samples</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
          {SAMPLE_TEMPLATES.map((preset) => (
            <Tile
              key={preset.id}
              name={preset.name}
              hint={preset.hint}
              theme={preset.theme}
              current={isCurrent(preset.theme)}
              onApply={() => onApply(preset.theme)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
