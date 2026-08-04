import { useEffect, useRef, useState } from "react";

import {
  onFinal,
  onInterim,
  onStatus,
  speechStatus,
  type SpeechStatus,
  type TranscriptPayload,
} from "./api";

export interface TranscriptLine {
  id: number;
  text: string;
  /** Wall-clock time the line was confirmed, for the timestamp gutter. */
  at: number;
}

/**
 * A guard against a session left running for days, not a display limit.
 *
 * Azure confirms a segment every few seconds, so a 40-minute sermon lands
 * somewhere around 250-500 lines and a long service several times that. The
 * old ceiling of 400 silently dropped the opening of anything lengthy, which
 * mattered little on screen but truncated exports without saying so.
 */
const MAX_LINES = 5000;

/**
 * Subscribes to the transcript event bus.
 *
 * Interim text is whatever Azure currently believes is being said and is
 * replaced wholesale on each update; final text is appended once confirmed.
 */
export function useTranscript() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState("");
  const [status, setStatus] = useState<SpeechStatus>({
    state: "idle",
    detail: null,
    device: null,
  });
  const nextId = useRef(0);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    const subscribe = async () => {
      const [stopInterim, stopFinal, stopStatus] = await Promise.all([
        onInterim((payload: TranscriptPayload) => {
          if (active) setInterim(payload.text);
        }),
        onFinal((payload: TranscriptPayload) => {
          if (!active) return;
          // The final result supersedes whatever interim text was showing.
          setInterim("");
          setLines((current) => {
            const next = [...current, { id: nextId.current++, text: payload.text, at: Date.now() }];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }),
        onStatus((next) => {
          if (!active) return;
          setStatus(next);
          // A session that has stopped should not leave half-recognised words
          // frozen on screen.
          if (next.state === "idle" || next.state === "error") setInterim("");
        }),
      ]);

      unlisteners.push(stopInterim, stopFinal, stopStatus);
      if (!active) unlisteners.forEach((stop) => stop());
    };

    void subscribe();
    // The window may have opened after a session was already running.
    void speechStatus()
      .then((current) => {
        if (active) setStatus(current);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisteners.forEach((stop) => stop());
    };
  }, []);

  const clear = () => {
    setLines([]);
    setInterim("");
  };

  return { lines, interim, status, clear };
}
