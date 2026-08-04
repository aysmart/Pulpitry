import { useCallback, useEffect, useState } from "react";

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Verse } from "./bible";

export const EVENT_SUGGESTION = "suggestion:verse";

/** Which path produced a suggestion. */
export type SuggestionSource = "semantic" | "model";

export interface Suggestion {
  /** Always read from the local library, never from a model. */
  verse: Verse;
  source: SuggestionSource;
  kind: "quotation" | "allusion";
  /** The model's own estimate, not a calibrated probability. */
  confidence: number;
  reason: string;
  /** The speech the suggestion was drawn from. */
  context: string;
  at: number;
}

const MAX_SUGGESTIONS = 40;

export const onSuggestion = (handler: (suggestion: Suggestion) => void): Promise<UnlistenFn> =>
  listen<Suggestion>(EVENT_SUGGESTION, (event) => handler(event.payload));

/**
 * Collects model-proposed passages, newest first.
 *
 * These are suggestions, not detections: the model decided the speaker was
 * referring to a passage, and the reference was then verified against the
 * library. The verse text itself always comes from the database.
 */
export function useSuggestions() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    void onSuggestion((suggestion) => {
      if (!active) return;
      setSuggestions((current) => {
        // The two sources agree often; keep the stronger claim rather than
        // listing the same verse twice.
        const withoutDuplicate = current.filter(
          (existing) => existing.verse.id !== suggestion.verse.id,
        );
        return [suggestion, ...withoutDuplicate].slice(0, MAX_SUGGESTIONS);
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

  const clear = useCallback(() => setSuggestions([]), []);

  return { suggestions, clear };
}
