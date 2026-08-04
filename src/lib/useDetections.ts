import { useCallback, useEffect, useState } from "react";

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Verse } from "./bible";

export const EVENT_DETECTION = "detection:verse";

export interface Detection {
  verse: Verse;
  /** The speaker's own words that matched, for comparison against the verse. */
  snippet: string;
  wordsMatched: number;
  /** 0 to 1. */
  confidence: number;
  at: number;
}

/** A long service should not accumulate an unbounded list. */
const MAX_DETECTIONS = 60;

export const onDetection = (handler: (detection: Detection) => void): Promise<UnlistenFn> =>
  listen<Detection>(EVENT_DETECTION, (event) => handler(event.payload));

/**
 * Collects verses detected in the live transcript, newest first.
 *
 * The same verse can be detected again as the speaker keeps reading it, so a
 * repeat updates the existing entry and moves it to the top rather than adding
 * a duplicate the operator has to scan past.
 */
export function useDetections() {
  const [detections, setDetections] = useState<Detection[]>([]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    void onDetection((detection) => {
      if (!active) return;
      setDetections((current) => {
        const withoutDuplicate = current.filter(
          (existing) => existing.verse.id !== detection.verse.id,
        );
        return [detection, ...withoutDuplicate].slice(0, MAX_DETECTIONS);
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

  const clear = useCallback(() => setDetections([]), []);

  return { detections, clear };
}
