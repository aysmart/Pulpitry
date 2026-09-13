import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import {
  getMediaProgress,
  reportMediaProgress,
  type MediaCommand,
} from "../lib/projector";

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
  /** Whether this surface is an output rather than a look ahead. */
  const live = Boolean(command);

  /*
   * A clip joins the service where it is, not where the file starts.
   *
   * # What went wrong
   *
   * This element is unmounted and rebuilt whenever the surface around it is --
   * changing desk is the obvious one, because the arrangements are different
   * trees -- and a rebuilt `<video>` is a new decode of the file at zero. With
   * the projector closed, the Live pane *is* the output, so a clip running
   * under the notices went back to its first frame every time the operator
   * looked at another desk and came back.
   *
   * # Why the backend is asked rather than the position kept here
   *
   * Where the clip is is a fact about the service, not about this component,
   * and one is already kept: whichever surface the congregation is watching
   * reports it, and `set_live` resets it to zero as a clip goes up. So a clip
   * staged again later still starts at the beginning -- which is what anybody
   * would expect -- and a remount mid-clip lands where the room is. Holding a
   * position per file in here would get the first of those wrong.
   *
   * It also fixes the neighbouring case: a projector opened halfway through a
   * clip used to start it again from the beginning on that screen while the
   * desk pane carried on, so the two surfaces showed different seconds of the
   * same file.
   *
   * Live surfaces only. Preview is a look ahead rather than an output, and a
   * clip there has nothing to do with where the service has got to.
   */
  useEffect(() => {
    const element = video.current;
    if (!element || !live) return;

    /*
     * A mount is not a seek.
     *
     * The seek below is edge-triggered on the nonce, and a fresh element has
     * seen no edges -- so it obeyed the standing one, which is the `seekTo: 0`
     * written when the clip went up however long ago. That put every rebuilt
     * surface back to the first frame before this effect could say otherwise.
     * The nonce standing at mount has already been obeyed by whatever was on
     * screen before this element existed.
     */
    if (command) lastSeek.current = command.seekNonce;

    let active = true;
    void getMediaProgress()
      .then((where) => {
        if (!active || where.position <= 0) return;

        const join = () => {
          element.currentTime = where.position;
          // A clip that has finished stays finished. `autoplay` and a command
          // that still says playing would otherwise run it again in front of
          // the congregation, which is a strange thing for changing desks to
          // do.
          if (where.ended) element.pause();
        };

        // HAVE_METADATA: before that there is no duration and seeking is
        // ignored, which is exactly the state a freshly mounted element is in.
        if (element.readyState >= 1) join();
        else element.addEventListener("loadedmetadata", join, { once: true });
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
    // Once per clip, per mount. `command` is deliberately not a dependency:
    // every play, pause and seek after this one is carried by the effects
    // below, and re-joining on each of them would fight them.
  }, [path, live]);

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
