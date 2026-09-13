import type { AudioState, MediaCommand, MediaProgress } from "../lib/projector";

/** "0:07", "1:42", "12:05". Hours are not a service video. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const BUTTON =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1 text-pulpitry-muted transition-colors hover:border-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring";

/**
 * Transport for the clip that is live.
 *
 * Shown only while one is, because it controls nothing otherwise. Everything
 * here acts on whichever surface is the real output, so the operator never has
 * to think about which window is doing the playing.
 */
export function MediaTransport({
  command,
  progress,
  audio,
  onPlay,
  onPause,
  onSeek,
  onRestart,
  onToggleLoop,
  onAudioChange,
}: {
  command: MediaCommand;
  progress: MediaProgress;
  audio: AudioState;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (to: number) => void;
  onRestart: () => void;
  onToggleLoop: () => void;
  onAudioChange: (next: Partial<AudioState>) => void;
}) {
  const silent = audio.muted || audio.volume === 0;
  // Duration is unknown until the file's metadata loads; a scrubber with no
  // range would jump to the far end on the first drag.
  const known = progress.duration > 0;
  const ended = progress.ended && !command.looping;

  return (
    <div
      className="flex shrink-0 items-center gap-2 rounded-md border border-pulpitry-line bg-pulpitry-surface px-2 py-1.5"
      // Play, pause and seek act on the clip that is already on the wall, so
      // Enter here means the button rather than the desk's "Enter twice puts
      // it up".
      data-own-enter
    >
      <button
        type="button"
        onClick={ended ? onRestart : command.playing ? onPause : onPlay}
        aria-label={ended ? "Play the clip again" : command.playing ? "Pause" : "Play"}
        title={ended ? "Play again" : command.playing ? "Pause" : "Play"}
        className={BUTTON}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          {command.playing && !ended ? (
            <>
              <rect x="3.5" y="2.5" width="3.2" height="11" rx="0.7" />
              <rect x="9.3" y="2.5" width="3.2" height="11" rx="0.7" />
            </>
          ) : (
            <path d="M4 2.6 13 8l-9 5.4z" />
          )}
        </svg>
      </button>

      <button type="button" onClick={onRestart} aria-label="Back to the start" title="Back to the start" className={BUTTON}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          <path d="M12 2.6 5 8l7 5.4z" />
          <rect x="2.6" y="2.6" width="1.8" height="10.8" rx="0.7" />
        </svg>
      </button>

      <button
        type="button"
        onClick={onToggleLoop}
        aria-label={command.looping ? "Stop looping" : "Loop this clip"}
        title={command.looping ? "Looping" : "Play once"}
        className={`${BUTTON} ${command.looping ? "border-pulpitry-gold-dim text-pulpitry-gold" : ""}`}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <path d="M3 6.5A3.5 3.5 0 0 1 6.5 3H11" strokeLinecap="round" />
          <path d="M13 9.5A3.5 3.5 0 0 1 9.5 13H5" strokeLinecap="round" />
          <path d="m9.5 1.5 2 1.5-2 1.5M6.5 11.5 4.5 13l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <input
        type="range"
        min={0}
        max={known ? progress.duration : 1}
        step={0.1}
        value={Math.min(progress.position, known ? progress.duration : 1)}
        disabled={!known}
        aria-label="Position in the clip"
        onChange={(event) => onSeek(Number(event.target.value))}
        className="h-1 min-w-0 flex-1 accent-pulpitry-gold disabled:opacity-30 focus-visible:focus-ring"
      />

      <span className="shrink-0 text-[11px] text-pulpitry-muted tabular-nums">
        {clock(progress.position)}
        {known ? ` / ${clock(progress.duration)}` : null}
      </span>

      {ended ? (
        // Said plainly, because a held last frame looks identical to a paused
        // one and the operator needs to know the clip is done.
        <span className="shrink-0 text-[11px] text-pulpitry-gold">Ended</span>
      ) : null}

      <span className="flex shrink-0 items-center gap-1.5 border-l border-pulpitry-line pl-2">
        <button
          type="button"
          onClick={() =>
            // Unmuting from a level of zero would still be silent, so bring
            // the level back with it.
            onAudioChange(
              silent
                ? { muted: false, volume: audio.volume === 0 ? 1 : audio.volume }
                : { muted: true },
            )
          }
          aria-label={silent ? "Unmute the clip" : "Mute the clip"}
          title={silent ? "Unmute" : "Mute"}
          className={`rounded px-1 py-0.5 transition-colors focus-visible:focus-ring ${
            silent ? "text-pulpitry-gold" : "text-pulpitry-muted hover:text-pulpitry-text"
          }`}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
            <path d="M8 2.2 4.6 5H2.2v6h2.4L8 13.8z" />
            {silent ? (
              <path d="M10.4 6.2 14 9.8M14 6.2l-3.6 3.6" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            ) : (
              <path d="M10.7 5.6a3.4 3.4 0 0 1 0 4.8M12.6 3.7a6 6 0 0 1 0 8.6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={audio.muted ? 0 : audio.volume}
          aria-label="Clip volume"
          onChange={(event) => onAudioChange({ volume: Number(event.target.value), muted: false })}
          className="h-1 w-16 accent-pulpitry-gold focus-visible:focus-ring"
        />
      </span>
    </div>
  );
}
