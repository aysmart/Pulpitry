import { useEffect, useState } from "react";

import {
  describeError,
  mirrorForget,
  mirrorOfferCode,
  mirrorState,
  mirrorWithdrawCode,
  onMirror,
  type MirrorState,
} from "../lib/api";

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[13px] text-pulpitry-text";

/**
 * Turning the mirror on, and pairing a screen with it.
 *
 * The whole of the operator's contact with the feature is here: a switch, a
 * code, and a list of what is paired. Everything else — discovery, the
 * handshake, holding the last verse when the wifi drops — happens without
 * anybody being told about it, which is the intended experience.
 *
 * # Why the code is large and the rest is small
 *
 * Somebody is reading the code off this screen and typing it into a different
 * machine across the room, possibly in a dark hall, possibly on a laptop
 * balanced on a chair. It is the only thing on this panel that has to be legible
 * from a distance, so it gets the size and the letter spacing and nothing else
 * competes with it.
 */
export function MirrorPanel({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [state, setState] = useState<MirrorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;

    void mirrorState()
      .then((current) => active && setState(current))
      .catch(() => undefined);
    void onMirror((next) => setState(next)).then((off) => {
      if (active) unlisten = off;
      else off();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const offer = async () => {
    setError(null);
    try {
      await mirrorOfferCode();
    } catch (err) {
      setError(describeError(err));
    }
  };

  const withdraw = async () => {
    try {
      await mirrorWithdrawCode();
    } catch (err) {
      setError(describeError(err));
    }
  };

  /**
   * Puts the code on the clipboard.
   *
   * Worth having even though the code is six characters and printed large:
   * the two machines are often one person with a laptop and a remote desktop
   * session, or a phone photographing a screen, and typing from a photograph
   * is where a transcription error comes from. `navigator.clipboard` needs a
   * secure context, which a Tauri webview is; the fallback covers the older
   * webviews on Linux where it is not.
   */
  const copy = async () => {
    const code = state?.code ?? "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const field = document.createElement("textarea");
      field.value = code;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand("copy");
      } finally {
        field.remove();
      }
    }
    setCopied(true);
    // Long enough to be read, short enough that the button is a button again
    // before somebody wants to press it a second time.
    window.setTimeout(() => setCopied(false), 1600);
  };

  const forget = async (id: string) => {
    try {
      await mirrorForget(id);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const code = state?.code ?? "";
  const paired = state?.paired ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-1">
          <span className="text-[13px] text-pulpitry-text">
            Show what is on the projector to Castavox
          </span>
          <span className="text-[11.5px] leading-snug text-pulpitry-muted">
            Castavox on another machine in the building draws the verse you are showing, in its
            own overlay design. Only the reference and its words cross the network — never a
            picture of the screen — so it works on church wifi without competing with anything
            else on it. It also means one machine listens for the sermon instead of two.
          </span>
        </span>
      </label>

      {state?.problem ? (
        <p className="rounded border border-pulpitry-line px-2.5 py-2 text-[12px] leading-snug text-pulpitry-gold">
          {state.problem}
        </p>
      ) : null}

      {enabled && state?.enabled ? (
        <>
          <div className="flex flex-col gap-2 rounded border border-pulpitry-line px-3 py-2.5">
            {code ? (
              <>
                <span className="text-[11.5px] text-pulpitry-muted">
                  Type this into Castavox, under Mirror in its settings.
                </span>
                {/* The one thing on this panel meant to be read across a room. */}
                <span className="font-mono text-[30px] leading-none tracking-[0.22em] text-pulpitry-text">
                  {code}
                </span>
                <span className="text-[11.5px] text-pulpitry-muted">
                  It works once, and for five minutes. Ask for another whenever you need one.
                </span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void copy()} className={FIELD}>
                    {copied ? "Copied" : "Copy code"}
                  </button>
                  <button type="button" onClick={() => void withdraw()} className={FIELD}>
                    Stop showing it
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-[12px] leading-snug text-pulpitry-muted">
                  {paired.length > 0
                    ? "Pair another screen, or re-pair one that has been reinstalled."
                    : "Castavox will find this machine on its own. The code is how it proves it is allowed to connect."}
                </span>
                <button type="button" onClick={() => void offer()} className={`${FIELD} self-start`}>
                  Show a pairing code
                </button>
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11.5px] text-pulpitry-muted">
              {paired.length === 0
                ? "No screens paired yet."
                : `${paired.length} paired · ${state.watching} connected now`}
            </span>
            {paired.map((screen) => (
              <div
                key={screen.id}
                className="flex items-center justify-between gap-2 rounded border border-pulpitry-line px-2.5 py-1.5"
              >
                <span className="truncate text-[12.5px] text-pulpitry-text">{screen.name}</span>
                <button
                  type="button"
                  onClick={() => void forget(screen.id)}
                  className="shrink-0 text-[11.5px] text-pulpitry-muted underline-offset-2 hover:underline"
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {error ? <p className="text-[12px] text-pulpitry-gold">{error}</p> : null}
    </div>
  );
}
