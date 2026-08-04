import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * A clip on screen, wherever that screen is.
 *
 * Shared by the projector and the operator's Live pane so a change to how
 * playback behaves lands in both. `volume` is why this is a component rather
 * than a bare `<video>`: it is a property of the element, not an attribute, so
 * React cannot set it from props and it has to be applied through a ref.
 */
export function VideoSurface({
  path,
  muted,
  volume,
  looping,
  autoPlay,
  className,
}: {
  path: string;
  muted: boolean;
  /** 0 to 1. Ignored while muted, but kept so unmuting restores the level. */
  volume: number;
  looping: boolean;
  autoPlay: boolean;
  className?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, volume));
  }, [volume]);

  return (
    <video
      ref={video}
      src={convertFileSrc(path)}
      muted={muted}
      loop={looping}
      autoPlay={autoPlay}
      playsInline
      className={className}
    />
  );
}
