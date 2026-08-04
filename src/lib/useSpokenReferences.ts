import { useCallback, useEffect, useState } from "react";

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Verse } from "./bible";

export const EVENT_SPOKEN = "detection:reference";

export interface SpokenReference {
  verse: Verse;
  /** The speaker named a chapter without a verse. */
  wholeChapter: boolean;
  /** The words that named it. */
  phrase: string;
  at: number;
}

const MAX_REFERENCES = 40;

/**
 * References the speaker announced out loud.
 *
 * Kept apart from detections and suggestions because the signal is different
 * in kind: nothing was inferred. The speaker said where they were going, so
 * these are certain in a way a text or meaning match never is.
 */
export function useSpokenReferences() {
  const [references, setReferences] = useState<SpokenReference[]>([]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    void listen<SpokenReference>(EVENT_SPOKEN, (event) => {
      if (!active) return;
      setReferences((current) => {
        const withoutDuplicate = current.filter(
          (existing) => existing.verse.id !== event.payload.verse.id,
        );
        return [event.payload, ...withoutDuplicate].slice(0, MAX_REFERENCES);
      });
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const clear = useCallback(() => setReferences([]), []);

  return { references, clear };
}
