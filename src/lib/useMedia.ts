import { useCallback, useEffect, useState } from "react";

import {
  getMedia,
  getMediaProgress,
  onMedia,
  onMediaProgress,
  setMedia,
  type MediaCommand,
  type MediaProgress,
} from "./projector";

const IDLE: MediaCommand = { playing: true, looping: false, seekNonce: 0, seekTo: 0 };
const NOWHERE: MediaProgress = { position: 0, duration: 0, ended: false };

/**
 * The transport for whatever clip is live.
 *
 * The command is set here and obeyed by both surfaces; the progress comes back
 * from whichever one is actually the output. Keeping both in Rust is what lets
 * the operator pause the wall from their own window.
 */
export function useMedia() {
  const [command, setCommand] = useState<MediaCommand>(IDLE);
  const [progress, setProgress] = useState<MediaProgress>(NOWHERE);

  useEffect(() => {
    let active = true;
    const stops: Array<() => void> = [];

    void getMedia().then((current) => active && setCommand(current)).catch(() => undefined);
    void getMediaProgress().then((at) => active && setProgress(at)).catch(() => undefined);

    void Promise.all([
      onMedia((next) => active && setCommand(next)),
      onMediaProgress((next) => active && setProgress(next)),
    ]).then((unlisteners) => {
      stops.push(...unlisteners);
      if (!active) stops.forEach((stop) => stop());
    });

    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, []);

  const send = useCallback((next: Partial<MediaCommand>) => {
    setCommand((current) => {
      const merged = { ...current, ...next };
      void setMedia(merged).catch(() => undefined);
      return merged;
    });
  }, []);

  const play = useCallback(() => send({ playing: true }), [send]);
  const pause = useCallback(() => send({ playing: false }), [send]);
  const toggleLoop = useCallback(
    () => setCommand((current) => {
      const merged = { ...current, looping: !current.looping };
      void setMedia(merged).catch(() => undefined);
      return merged;
    }),
    [],
  );

  /** Jumps, and keeps playing if it was playing. The nonce is what moves it. */
  const seek = useCallback(
    (to: number) =>
      setCommand((current) => {
        const merged = { ...current, seekTo: to, seekNonce: current.seekNonce + 1 };
        void setMedia(merged).catch(() => undefined);
        return merged;
      }),
    [],
  );

  const restart = useCallback(() => {
    seek(0);
    play();
  }, [seek, play]);

  return { command, progress, play, pause, seek, restart, toggleLoop };
}
