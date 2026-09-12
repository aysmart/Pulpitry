import { useCallback, type RefObject } from "react";

import { CANVAS, within, type Box } from "./design";

/**
 * Moving and resizing a box on a canvas that is not its own size.
 *
 * Every design surface in Pulpitry draws into a 16:9 box of whatever width the
 * window gives it, while the thing being dragged is measured against
 * 1920 × 1080. So a drag is two conversions: screen pixels to canvas units at
 * the scale the canvas happens to be at right now, and then back inside the
 * frame.
 *
 * Written once because it is written identically in the slide studio and the
 * shape studio, and a copy would be a second place for the scale to be wrong —
 * which does not look like a bug, it looks like the canvas lagging behind the
 * mouse.
 *
 * The scale is measured when the drag starts rather than held, so it is right
 * at any zoom, after any window resize, and on a canvas that has just been
 * re-laid-out under the pointer.
 */
export function useDragBox(
  canvas: RefObject<HTMLElement | null>,
  onChange: (box: Box) => void,
) {
  return useCallback(
    (event: React.PointerEvent, from: Box, what: "move" | "resize") => {
      event.stopPropagation();
      event.preventDefault();

      const rect = canvas.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const scale = CANVAS.width / rect.width;
      const start = { px: event.clientX, py: event.clientY, ...from };

      const move = (moved: PointerEvent) => {
        const dx = (moved.clientX - start.px) * scale;
        const dy = (moved.clientY - start.py) * scale;
        onChange(
          within(
            what === "move"
              ? { ...from, x: start.x + dx, y: start.y + dy }
              : { ...from, w: start.w + dx, h: start.h + dy },
          ),
        );
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [canvas, onChange],
  );
}
