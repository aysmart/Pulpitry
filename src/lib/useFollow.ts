import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Presentable } from "./usePresentation";

/**
 * Following the service: which slide of the staged deck the speaker is on.
 *
 * # Suggested, not done
 *
 * The suggestion is offered and the operator takes it, unless they have
 * explicitly asked otherwise. A wrong verse in the queue is a shrug; a deck
 * that jumps to the wrong slide is a visible failure in front of a
 * congregation, at the moment a preacher is relying on it, and the person who
 * looks incompetent is the volunteer at the desk.
 *
 * # What is sent to be matched
 *
 * A slide's words, in its own order, joined into one string. Its label goes
 * with them — "The Coming of the Son of Man" is often exactly the phrase a
 * preacher says on reaching it, and leaving it out throws away the strongest
 * clue a deck contains.
 */

export interface SlideSuggestion {
  index: number;
  score: number;
  advance: boolean;
}

/** A slide as one line of text, for matching rather than for showing. */
function wordsOf(section: {
  label: string;
  lines: string[];
  components?: Array<Record<string, unknown>>;
}): string {
  const fromComponents = (section.components ?? [])
    .map((component) =>
      component.kind === "text" ? String(component.text ?? "") : "",
    )
    .filter(Boolean);

  return [section.label, ...section.lines, ...fromComponents]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function useFollow(
  preview: Presentable | null,
  onSuggested: (suggestion: SlideSuggestion) => void,
) {
  const [following, setFollowing] = useState(false);
  const [advance, setAdvance] = useState(false);
  const [suggestion, setSuggestion] = useState<SlideSuggestion | null>(null);

  /*
   * Registered once and reached through a ref, for the reason the voice
   * handler is: re-registering a listener drops whatever arrives during the
   * swap, and a suggestion lost that way is one the operator never sees.
   */
  const onSuggestedRef = useRef(onSuggested);
  onSuggestedRef.current = onSuggested;

  useEffect(() => {
    let active = true;
    let stop: UnlistenFn | undefined;
    void listen<SlideSuggestion>("slide:suggested", ({ payload }) => {
      setSuggestion(payload);
      onSuggestedRef.current(payload);
    }).then((off) => {
      if (active) stop = off;
      else off();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  /*
   * The deck is re-sent whenever it changes, and cleared when it is not a
   * deck at all.
   *
   * Following a deck that is no longer staged would suggest slides of
   * something the operator has moved on from — which is worse than not
   * following, because it looks like it is working.
   */
  const deckKey =
    preview?.kind === "lyric"
      ? `${preview.title}:${preview.sections.length}`
      : "";

  useEffect(() => {
    if (!following) return;
    const slides =
      preview?.kind === "lyric" ? preview.sections.map(wordsOf) : [];
    void invoke("note", {
      line: `follow: on=${following} advance=${advance} kind=${preview?.kind ?? "none"} slides=${slides.length} first=${JSON.stringify(slides[0]?.slice(0, 80) ?? "")}`,
    }).catch(() => undefined);
    void invoke<boolean>("follow_deck", { slides, advance }).catch(
      () => undefined,
    );
    setSuggestion(null);
    // `preview` deliberately absent: it changes on every step through the
    // deck, and re-embedding twenty slides each time somebody presses Next
    // would be work for no answer. The key changes when the deck does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, advance, deckKey]);

  const stop = useCallback(() => {
    setFollowing(false);
    setSuggestion(null);
    void invoke("follow_deck", { slides: [], advance: false }).catch(
      () => undefined,
    );
  }, []);

  return {
    following,
    setFollowing,
    advance,
    setAdvance,
    suggestion,
    clearSuggestion: () => setSuggestion(null),
    stop,
    /** Whether there is anything to follow: only a deck has slides. */
    canFollow: preview?.kind === "lyric",
  };
}
