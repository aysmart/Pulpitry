import { open } from "@tauri-apps/plugin-dialog";

import { catalogSave, newItem, type Item } from "./catalog";

export const IMAGE_TYPES = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
export const VIDEO_TYPES = ["mp4", "mov", "m4v", "webm", "avi", "mkv"];

/** "/pictures/Advent Week 1.jpg" reads as "Advent Week 1". */
export function titleFor(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Brings files into the library as items, and returns what was added.
 *
 * Here rather than in the media library because two places now put pictures in
 * — the library itself, and the slide review, where an operator wants one on
 * the slide in front of them rather than a detour through another screen. One
 * import, so a picture added from either place is the same kind of thing and
 * findable in both.
 *
 * The file is referenced where it sits and not copied. That is the existing
 * behaviour and it is load-bearing: a church keeps its pictures in a folder it
 * backs up, and a second copy inside the app is one that silently goes stale.
 */
export async function importAssets(kind: "image" | "media"): Promise<Item[]> {
  const picked = await open({
    multiple: true,
    filters: [
      kind === "image"
        ? { name: "Images", extensions: IMAGE_TYPES }
        : { name: "Video", extensions: VIDEO_TYPES },
    ],
  });

  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  const added: Item[] = [];
  for (const path of paths) {
    added.push(
      await catalogSave(
        newItem(
          titleFor(path),
          // Filling by default: a picture staged as content is meant to be
          // the screen, and the operator can switch it back in the library.
          kind === "image"
            ? { kind: "image", fill: true }
            : { kind: "media", looping: false, fill: true },
          path,
        ),
      ),
    );
  }
  return added;
}
