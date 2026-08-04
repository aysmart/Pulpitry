import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { nodeStatus, type NodeStatus } from "../lib/api";

const DOWNLOAD = "https://nodejs.org/en/download";

/**
 * Whether this machine can transcribe at all.
 *
 * Pulpitry does not ship a Node runtime — fusing one into the app cost 115 MB
 * to deliver a single WebSocket client. The trade is that it can be absent,
 * and an operator has no way to guess that from a failure to start listening.
 * So it is stated here, before a service rather than during one, and it says
 * plainly that everything else still works.
 */
export function NodeRuntimeNotice() {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await nodeStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (!status) return null;

  if (status.found) {
    return (
      <p className="text-[11.5px] text-pulpitry-muted">
        Node {status.version} found — live transcription is ready.
      </p>
    );
  }

  return (
    <div className="rounded border border-pulpitry-gold-dim bg-pulpitry-gold/5 px-2.5 py-2">
      <p className="text-[12.5px] text-pulpitry-text">
        {status.tooOld
          ? `Node ${status.version} is installed, but live transcription needs ${status.minimum} or newer.`
          : "The Node runtime is not installed, so live transcription cannot start."}
      </p>
      <p className="mt-1 text-[11.5px] text-pulpitry-muted">
        Everything else — the verse library, songs, slides and the projector —
        works without it.
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void openUrl(DOWNLOAD)}
          className="rounded bg-pulpitry-gold px-2.5 py-1 text-[12px] text-pulpitry-ink focus-visible:focus-ring"
        >
          Get Node
        </button>
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking}
          title="Look again, after installing it"
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1 text-[12px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
    </div>
  );
}
