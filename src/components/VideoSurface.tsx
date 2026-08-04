import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { reportMediaProgress, type MediaCommand } from "../lib/projector";

/**
 * A clip on screen, wherever that screen is.
 *
 * Shared by the projector and the operator's Live pane so a change to how
 * playback behaves lands in both. Both obey the same command, which is what
 * keeps them together: they are two decodes of one file, synchronised at every
 * play, pause and seek rather than continuously.
 *
 * Most of this has to be imperative. `volume`, `currentTime` and playback are
 * properties and methods of the element, not attributes, so React cannot drive
 * them from props.
 */
export function VideoSurface({
  path,
  muted,
  volume,
  looping,
  command,
  /** Only the surface the congregation is watching reports where it is. */
  reportProgress = false,
  className,
}: {
  path: string;
  muted: boolean;
  /** 0 to 1. Ignored while muted, but kept so unmuting restores the level. */
  volume: number;
  looping: boolean;
  command?: MediaCommand;
  reportProgress?: boolean;
  className?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const lastSeek = useRef<number | null>(null);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, volume));
  }, [volume]);

  useEffect(() => {
    const element = video.current;
    if (!element || !command) return;
    if (command.playing) {
      // Rejected when the file will not decode or autoplay is refused; there
      // is nothing useful to do about it beyond not crashing the window.
      void element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }, [command?.playing, command]);

  // Seeks are edge-triggered on the nonce, so asking twice for the same
  // position still moves the clip both times.
  useEffect(() => {
    const element = video.current;
    if (!element || !command) return;
    if (lastSeek.current === command.seekNonce) return;
    lastSeek.current = command.seekNonce;
    element.currentTime = command.seekTo;
    // A clip that ran to the end is paused while the command still says
    // playing, so nothing would restart it: jumping back has to resume too.
    if (command.playing) void element.play().catch(() => undefined);
  }, [command?.seekNonce, command]);

  useEffect(() => {
    const element = video.current;
    if (!element || !reportProgress) return;

    const report = (ended: boolean) =>
      void reportMediaProgress({
        // Rounded to a tenth: this crosses a window boundary several times a
        // second, and nobody reads a projector clock to the millisecond.
        position: Math.round(element.currentTime * 10) / 10,
        duration: Number.isFinite(element.duration) ? Math.round(element.duration * 10) / 10 : 0,
        ended,
      }).catch(() => undefined);

    const onTime = () => report(false);
    const onEnded = () => report(true);

    element.addEventListener("timeupdate", onTime);
    element.addEventListener("loadedmetadata", onTime);
    element.addEventListener("ended", onEnded);
    return () => {
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("loadedmetadata", onTime);
      element.removeEventListener("ended", onEnded);
    };
  }, [reportProgress, path]);

  return (
    <video
      ref={video}
      src={convertFileSrc(path)}
      muted={muted}
      loop={looping}
      autoPlay
      playsInline
      className={className}
    />
  );
}
