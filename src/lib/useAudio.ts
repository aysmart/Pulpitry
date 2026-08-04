import { useCallback, useEffect, useState } from "react";

import { getAudio, onAudio, setAudio, type AudioState } from "./projector";

/**
 * Volume for whatever clip is live.
 *
 * Held in Rust and mirrored here, like the live content itself, so the
 * operator's pane and the projector cannot disagree about what the
 * congregation is hearing.
 */
export function useAudio() {
  const [audio, setState] = useState<AudioState>({ muted: false, volume: 1 });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void getAudio().then((current) => active && setState(current)).catch(() => undefined);
    void onAudio((next) => active && setState(next)).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const change = useCallback((next: Partial<AudioState>) => {
    // Applied locally first so the slider tracks the pointer rather than
    // waiting on a round trip; the event that follows agrees with it.
    setState((current) => {
      const merged = { ...current, ...next };
      void setAudio(merged).catch(() => undefined);
      return merged;
    });
  }, []);

  return { audio, change };
}
