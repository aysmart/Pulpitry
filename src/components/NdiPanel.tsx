import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Putting the projector on the network for other software to take.
 *
 * # Not the mirror, and the panel says so
 *
 * These two sit near each other in Settings and are opposite answers. The
 * mirror sends a *reference* — a few dozen bytes — and Castavox draws the verse
 * from its own library, which is why it works on church wifi. This sends the
 * actual picture at around 100 Mbit/s, which is why it does not.
 *
 * An operator who turns this on expecting the mirror will flood the network
 * they are also streaming over, on a Sunday. So the difference is stated here,
 * in the panel, rather than left to a manual nobody opens.
 *
 * # Absence is not an error
 *
 * Most churches will never install the NDI runtime and should not meet a red
 * message about it. When it is missing the row explains what NDI is for and
 * what to install; it does not complain.
 */

interface NdiState {
  available: boolean;
  running: boolean;
  name: string;
  error: string | null;
}

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

export function NdiPanel() {
  const [state, setState] = useState<NdiState | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void invoke<NdiState>("ndi_status")
      .then((next) => {
        if (!live) return;
        setState(next);
        setName(next.name);
      })
      // Settings must open whatever this does.
      .catch(() => live && setState({ available: false, running: false, name: "", error: null }));
    return () => {
      live = false;
    };
  }, []);

  async function apply(enabled: boolean) {
    setBusy(true);
    try {
      const next = await invoke<NdiState>("ndi_set", { enabled, name });
      setState(next);
      setName(next.name);
    } catch (err) {
      setState((current) =>
        current ? { ...current, running: false, error: String(err) } : current,
      );
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-pulpitry-text">Send the screen over NDI</span>
        {state.running ? (
          <span className="text-[11.5px] text-pulpitry-teal">on the network</span>
        ) : null}
      </div>

      {state.available ? (
        <>
          <div className="flex gap-2">
            <input
              value={name}
              spellCheck={false}
              placeholder="Pulpitry"
              onChange={(event) => setName(event.target.value)}
              className={`min-w-0 flex-1 ${FIELD}`}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void apply(!state.running)}
              className="shrink-0 rounded border border-pulpitry-line px-3 py-2 text-[12.5px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
            >
              {busy ? "…" : state.running ? "Stop" : "Start"}
            </button>
          </div>

          {/* The name matters on a network with two campuses: "Pulpitry" twice
              in a switcher's source list is a coin toss. */}
          <p className="text-[11.5px] leading-snug text-pulpitry-muted">
            What the projector is showing, published for OBS, vMix, a hardware switcher or
            anything else that speaks NDI — no capture card. It is the whole picture rather than
            a reference, so it wants a{" "}
            <span className="text-pulpitry-text">wired network</span>: about 100 Mbit/s for
            1080p, which is not what you want beside a stream on wifi.{" "}
            <span className="text-pulpitry-text">To send verses to Castavox, use Mirror above
            instead</span> — that sends a few dozen bytes and works on any connection.
          </p>

          {state.error ? (
            <p role="alert" className="text-[11.5px] leading-snug text-pulpitry-gold">
              {state.error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[11.5px] leading-snug text-pulpitry-muted">
          Publishes the projector to the network for a video switcher or a second machine to
          take. It needs the NDI runtime, which is free but is Vizrt&rsquo;s to give rather than
          ours to include — install NDI Tools from ndi.video and reopen Pulpitry. Most churches
          never need this: to put verses on a Castavox, use Mirror above.
        </p>
      )}
    </div>
  );
}
