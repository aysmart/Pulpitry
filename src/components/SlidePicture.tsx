import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { catalogList, type Item } from "../lib/catalog";
import { importAssets } from "../lib/pictures";
import type { ImageSource } from "../lib/projector";

/**
 * Puts one of the church's pictures behind a slide, while reviewing it.
 *
 * One component used by both review lists rather than a copy in each. The two
 * have drifted before -- over what a slide is made of, and then over how it is
 * arranged -- and each time the copy an operator actually reached silently did
 * less than the other one.
 *
 * A picture is chosen rather than suggested, deliberately, and that is the
 * whole of this step. Matching a mood against the library and generating one
 * where nothing matches are both real, and both are answers to "which
 * picture"; neither is worth building until there is a slide that can hold one
 * and an operator who can see the result.
 */
export function SlidePicture({
  source,
  onChange,
}: {
  source: ImageSource | null;
  onChange: (source: ImageSource | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pictures, setPictures] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || pictures) return;
    let live = true;
    catalogList("image", 200)
      .then((found) => live && setPictures(found))
      .catch(() => live && setError("The picture library could not be read."));
    return () => {
      live = false;
    };
  }, [open, pictures]);

  const add = async () => {
    setError(null);
    try {
      const added = await importAssets("image");
      const [first] = added;
      // Straight onto the slide: the operator opened a file chooser to put a
      // picture on *this* slide, and making them pick it again from a list
      // they just added it to is a step that answers nothing.
      if (first?.id && first.path) {
        onChange({ from: "library", itemId: first.id, path: first.path });
        setOpen(false);
      }
      setPictures(null);
    } catch {
      setError("That picture could not be added.");
    }
  };

  if (source) {
    return (
      <div className="flex items-center gap-2">
        <img
          src={convertFileSrc(source.path)}
          alt=""
          className="h-10 w-16 rounded border border-pulpitry-line object-cover"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="rounded px-2 py-1 text-[11.5px] text-pulpitry-muted underline-offset-2 hover:underline focus-visible:focus-ring"
        >
          Remove picture
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded px-2 py-1 text-[11.5px] text-pulpitry-muted underline-offset-2 hover:underline focus-visible:focus-ring"
      >
        Add a picture
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-pulpitry-line bg-pulpitry-raised p-2">
      {error ? <p className="text-[11.5px] text-pulpitry-gold">{error}</p> : null}

      {pictures === null ? (
        <p className="text-[11.5px] text-pulpitry-muted">Reading the library&hellip;</p>
      ) : pictures.length === 0 ? (
        /* Said plainly rather than shown as an empty grid. An operator looking
           at nothing cannot tell a library with no pictures from one that
           failed to load. */
        <p className="text-[11.5px] leading-snug text-pulpitry-muted">
          No pictures in the library yet. Add one and it stays, for this slide and for
          anything else.
        </p>
      ) : (
        <div className="grid max-h-40 grid-cols-4 gap-2 overflow-auto">
          {pictures.map((picture) =>
            picture.id && picture.path ? (
              <button
                key={picture.id}
                type="button"
                title={picture.title}
                onClick={() => {
                  onChange({ from: "library", itemId: picture.id!, path: picture.path! });
                  setOpen(false);
                }}
                className="overflow-hidden rounded border border-pulpitry-line focus-visible:focus-ring"
              >
                <img
                  src={convertFileSrc(picture.path)}
                  alt={picture.title}
                  className="h-12 w-full object-cover"
                />
              </button>
            ) : null,
          )}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={add}
          className="rounded px-2 py-1 text-[11.5px] text-pulpitry-text underline-offset-2 hover:underline focus-visible:focus-ring"
        >
          Add a picture&hellip;
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded px-2 py-1 text-[11.5px] text-pulpitry-muted underline-offset-2 hover:underline focus-visible:focus-ring"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
