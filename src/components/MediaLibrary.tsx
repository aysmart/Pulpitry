import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { catalogList, catalogRemove, catalogSave, type Item } from "../lib/catalog";
import { importAssets } from "../lib/pictures";
import { presentableFor } from "../lib/schedule";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";

const VIEW_KEY = "pulpitry.media.view";

type View = "thumbnails" | "list";
type Filter = "image" | "media";

const storedView = (): View =>
  localStorage.getItem(VIEW_KEY) === "list" ? "list" : "thumbnails";


/**
 * Pictures and clips.
 *
 * Thumbnails by default, and this is the one place they are clearly right: a
 * picture has no title worth reading, and an operator finds the one they want
 * by recognising it. The list view is there for a folder of near-identical
 * frames, where the filename is the only thing telling them apart.
 */
export function MediaLibrary({
  onPreview,
  previewKey,
  liveKey,
  keyOf,
  onError,
}: {
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
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>("image");
  const [view, setView] = useState<View>(storedView);
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (err: unknown) => onError(err instanceof Error ? err.message : String(err)),
    [onError],
  );

  const refresh = useCallback(async () => {
    try {
      setItems(await catalogList(filter));
    } catch (err) {
      fail(err);
    }
  }, [filter, fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Imports by reference: the file stays where the operator put it and the
   * library remembers the path. Copying gigabytes of video into an app folder
   * to show it once would be a poor trade.
   */
  const importFiles = async () => {
    setBusy(true);
    try {
      const added = await importAssets(filter);
      if (added.length > 0) await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Whether an item is set to fill the screen. */
  const fillOf = (item: Item) =>
    (item.body.kind === "image" || item.body.kind === "media") && item.body.fill;

  /**
   * Saves the fill switch back onto the item.
   *
   * The whole item, because that is what the catalogue takes. The body is
   * rebuilt rather than spread so the two kinds keep their own fields --
   * spreading would carry `looping` onto a picture, which is a field a picture
   * has no meaning for and would then be stored with.
   */
  const setFill = async (item: Item, fill: boolean) => {
    if (item.body.kind !== "image" && item.body.kind !== "media") return;
    try {
      await catalogSave({
        ...item,
        body:
          item.body.kind === "image"
            ? { kind: "image", fill }
            : { kind: "media", looping: item.body.looping, fill },
      });
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

  const stateOf = (item: Item): "idle" | "preview" | "live" => {
    const staged = presentableFor(item);
    if (!staged) return "idle";
    const key = keyOf(staged);
    if (key === liveKey) return "live";
    return key === previewKey ? "preview" : "idle";
  };

  const choose = (item: Item, andShow = false) => {
    const staged = presentableFor(item);
    if (staged) onPreview(staged, andShow);
  };

  const TAB = (value: Filter, label: string) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      className={`rounded px-2 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
        filter === value
          ? "bg-pulpitry-teal-dim text-pulpitry-text"
          : "text-pulpitry-muted hover:text-pulpitry-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-pulpitry-line px-2.5 py-2">
        {TAB("image", "Images")}
        {TAB("media", "Video")}

        <button
          type="button"
          onClick={() => {
            const next = view === "thumbnails" ? "list" : "thumbnails";
            setView(next);
            localStorage.setItem(VIEW_KEY, next);
          }}
          title={view === "thumbnails" ? "Show as a list" : "Show as thumbnails"}
          aria-label={view === "thumbnails" ? "Show as a list" : "Show as thumbnails"}
          className="ml-auto rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
            {view === "thumbnails" ? (
              <>
                <rect x="1" y="2" width="14" height="2.4" rx="0.6" />
                <rect x="1" y="6.8" width="14" height="2.4" rx="0.6" />
                <rect x="1" y="11.6" width="14" height="2.4" rx="0.6" />
              </>
            ) : (
              <>
                <rect x="1" y="2" width="6.2" height="5" rx="0.8" />
                <rect x="8.8" y="2" width="6.2" height="5" rx="0.8" />
                <rect x="1" y="9" width="6.2" height="5" rx="0.8" />
                <rect x="8.8" y="9" width="6.2" height="5" rx="0.8" />
              </>
            )}
          </svg>
        </button>
        <button
          type="button"
          onClick={() => void importFiles()}
          disabled={busy}
          title={filter === "image" ? "Add pictures" : "Add video clips"}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[12.5px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
        >
          Add
        </button>
      </div>

      {items.length === 0 ? (
        <EmptyState>
          {filter === "image"
            ? "No pictures yet. Press Add to bring some in — they stay where they are on disk."
            : "No clips yet. Press Add to bring some in — they stay where they are on disk."}
        </EmptyState>
      ) : view === "thumbnails" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] content-start gap-1.5 overflow-auto p-2">
          {items.map((item) => {
            const state = stateOf(item);
            return (
              <div
                key={item.id}
                className={`group relative aspect-video overflow-hidden rounded border transition-colors ${
                  state === "live"
                    ? "border-pulpitry-gold"
                    : state === "preview"
                      ? "border-pulpitry-teal"
                      : "border-pulpitry-line hover:border-pulpitry-muted"
                }`}
              >
                <button
                  type="button"
                  onClick={() => choose(item)}
                  onDoubleClick={() => choose(item, true)}
                  title={item.title}
                  className="block h-full w-full focus-visible:focus-ring"
                >
                {item.path && item.body.kind === "image" ? (
                  <img
                    src={convertFileSrc(item.path)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full bg-pulpitry-ink object-cover"
                  />
                ) : item.path ? (
                  // Metadata alone is enough for the first frame, which is all
                  // a thumbnail needs — loading whole clips would stall the grid.
                  <video
                    src={convertFileSrc(item.path)}
                    preload="metadata"
                    muted
                    className="h-full w-full bg-pulpitry-ink object-cover"
                  />
                ) : (
                  <span className="flex h-full items-center justify-center bg-pulpitry-raised text-[11px] text-pulpitry-muted">
                    missing
                  </span>
                )}

                  <span className="absolute inset-x-0 bottom-0 truncate bg-pulpitry-ink/80 px-1.5 py-1 text-left text-[11px] text-pulpitry-text">
                    {item.title}
                  </span>
                </button>

                {/* A sibling rather than nested, so clicking it cannot also
                    stage the tile it sits on. */}
                <button
                  type="button"
                  aria-label={`Remove ${item.title}`}
                  onClick={() => item.id !== null && void remove(item.id)}
                  className="absolute top-1 right-1 hidden rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[12px] leading-none text-pulpitry-muted group-hover:block hover:text-pulpitry-text focus-visible:focus-ring"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto p-1">
          {items.map((item) => {
            const state = stateOf(item);
            return (
              <li key={item.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => choose(item)}
                  onDoubleClick={() => choose(item, true)}
                  className={`min-w-0 flex-1 rounded px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                    state === "live"
                      ? "bg-pulpitry-gold/12"
                      : state === "preview"
                        ? "bg-pulpitry-teal-dim"
                        : "hover:bg-pulpitry-raised"
                  }`}
                >
                  <span className="block truncate text-[12.5px] text-pulpitry-text">
                    {item.title}
                  </span>
                  <span className="block truncate text-[11px] text-pulpitry-muted">
                    {item.path ?? "file missing"}
                  </span>
                </button>
                {/*
                  Whether this fills the screen or sits whole inside the frame.
                  On the item rather than on the moment it goes live, because
                  it is a property of the picture: a photograph fills, and a
                  graphic with words near its edges does not, and neither
                  changes between Sundays.
                */}
                <button
                  type="button"
                  onClick={() => void setFill(item, !fillOf(item))}
                  title={
                    fillOf(item)
                      ? "Fills the screen. Click to fit it whole instead."
                      : "Fitted whole. Click to fill the screen."
                  }
                  className="absolute top-1 left-1 hidden rounded bg-pulpitry-ink/80 px-1.5 py-0.5 text-[11px] leading-none text-pulpitry-muted group-hover:block hover:text-pulpitry-text focus-visible:focus-ring"
                >
                  {fillOf(item) ? "Fill" : "Fit"}
                </button>
                <button
                  type="button"
                  onClick={() => item.id !== null && void remove(item.id)}
                  aria-label={`Remove ${item.title}`}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
