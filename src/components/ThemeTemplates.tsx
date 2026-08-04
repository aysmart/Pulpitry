import { useCallback, useEffect, useState } from "react";

import {
  catalogList,
  catalogRemove,
  catalogSave,
  newItem,
  type Item,
} from "../lib/catalog";
import type { ProjectorTheme } from "../lib/theme";

/**
 * Named projector presets, stored in the library.
 *
 * A church settles on a look and wants it back next week, or keeps one for
 * carols and another for a normal Sunday. Saving the whole theme is cheaper
 * than asking anyone to remember which of eight controls they changed.
 */
export function ThemeTemplates({
  theme,
  onApply,
  onError,
}: {
  theme: ProjectorTheme;
  onApply: (theme: ProjectorTheme) => void;
  onError: (message: string) => void;
}) {
  const [templates, setTemplates] = useState<Item[]>([]);
  const [name, setName] = useState("");

  const refresh = useCallback(async () => {
    try {
      setTemplates(await catalogList("template"));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    const title = name.trim();
    if (!title) return;
    try {
      // Saving under an existing name replaces it, rather than leaving two
      // templates the operator cannot tell apart.
      const existing = templates.find(
        (item) => item.title.toLowerCase() === title.toLowerCase(),
      );
      const item = existing
        ? { ...existing, body: { kind: "template" as const, theme } }
        : newItem(title, { kind: "template", theme });

      await catalogSave(item);
      setName("");
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: number) => {
    try {
      await catalogRemove(id);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-pulpitry-line pt-3">
      <span className="text-[12px] text-pulpitry-muted">Templates</span>

      {templates.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {templates.map((item) => (
            <li key={item.id} className="flex items-center overflow-hidden rounded border border-pulpitry-line">
              <button
                type="button"
                onClick={() => {
                  if (item.body.kind === "template") onApply(item.body.theme);
                }}
                className="bg-pulpitry-raised px-2 py-1 text-[12px] text-pulpitry-text transition-colors hover:text-pulpitry-gold focus-visible:focus-ring"
              >
                {item.title}
              </button>
              <button
                type="button"
                onClick={() => item.id !== null && void remove(item.id)}
                aria-label={`Delete the ${item.title} template`}
                className="bg-pulpitry-raised px-1.5 py-1 text-[12px] leading-none text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-1.5">
        <input
          value={name}
          placeholder="Name this look…"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
          className="min-w-0 flex-1 rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12.5px] text-pulpitry-text outline-none placeholder:text-pulpitry-muted focus-visible:focus-ring"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!name.trim()}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-opacity disabled:opacity-40 focus-visible:focus-ring"
        >
          Save
        </button>
      </div>
    </div>
  );
}
