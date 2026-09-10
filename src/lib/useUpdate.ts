import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Whether there is a newer version, and installing it.
 *
 * # Why the application installs it rather than sending you to a page
 *
 * The download page works, and a church that never finds it stays on an old
 * version for ever. The people running this are volunteers who came to run a
 * service, not to keep software up to date, and every step between "there is a
 * new version" and "it is installed" is a step most of them will not take.
 *
 * # What it asks, and who it asks
 *
 * A manifest published beside the installers on the public downloads
 * repository. The request goes to GitHub rather than to us — which is what the
 * privacy policy says, and it also means there is no service of ours to be down
 * at the moment a church tries to update. Nothing about the machine is sent.
 *
 * Every build is signed and the signature is checked before anything is
 * installed. That matters more here than usual: an updater that will install
 * whatever a manifest points at is a way to put code on every machine in every
 * church running this, so it verifies rather than trusts.
 *
 * # When it asks
 *
 * Every time Pulpitry starts, rather than at most once a day. Under a daily
 * limit a launch within a day of the last one asks nothing, so a release
 * published on Saturday evening goes unnoticed by the laptop that was set up
 * on Saturday afternoon and opened again for the service.
 *
 * A launch that cannot reach the network asks again a little later, a few
 * times. The laptop that runs a service is often opened in the building and
 * starts Pulpitry before it has joined the wifi, and one failed question at
 * that moment was otherwise the only one of the day.
 *
 * # It never interrupts
 *
 * It does nothing at all until the operator presses install. A service must
 * never be interrupted by a download, and an application that restarts itself
 * mid-sermon would be worse than one that is out of date.
 */

/** How long after a failed check to ask again: a minute, then five, then fifteen. */
const RETRIES_MS = [60_000, 300_000, 900_000];
export interface UpdateState {
  /** The waiting version, or null when there is nothing to install. */
  version: string | null;
  /** How far a download has got, 0 to 1, or null when none is running. */
  progress: number | null;
  install: () => void;
  dismiss: () => void;
  error: string | null;
}

export function useUpdate(enabled: boolean): UpdateState {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;

    // Failure is silent. No network, a blocked domain, a manifest that has not
    // been published yet — none of them is worth a message to somebody who did
    // not ask a question. It only earns another try.
    const ask = (attempt: number) => {
      void check()
        .then((found) => {
          if (active && found) setUpdate(found);
        })
        .catch(() => {
          const wait = RETRIES_MS[attempt];
          if (active && wait !== undefined) {
            timer = window.setTimeout(() => ask(attempt + 1), wait);
          }
        });
    };
    ask(0);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  const install = useCallback(() => {
    if (!update) return;
    setError(null);
    setProgress(0);

    let downloaded = 0;
    let total = 0;

    void update
      .downloadAndInstall((event) => {
        // Sizes arrive on the first event and only there, so they are held
        // rather than read from each one.
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress(total > 0 ? Math.min(1, downloaded / total) : null);
        }
        if (event.event === "Finished") setProgress(1);
      })
      .then(() => relaunch())
      .catch((err) => {
        // Shown, unlike the check: the operator pressed a button and is owed an
        // answer. They can still install by hand from the download page.
        setProgress(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [update]);

  return {
    version: update?.version ?? null,
    progress,
    install,
    dismiss: () => setUpdate(null),
    error,
  };
}
