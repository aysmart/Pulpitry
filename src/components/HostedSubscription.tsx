import { useEffect, useState } from "react";

import { hostedActivate, hostedDeactivate, hostedStatus, type HostedView } from "../lib/api";

/**
 * The Castavox subscription, in Settings.
 *
 * A church on a plan transcribes on our Azure account instead of buying one.
 * What this needs from the operator is a licence key, once per machine; what it
 * owes them afterwards is a straight answer about how many hours are left,
 * because that is the number that decides whether Sunday works.
 *
 * Being unable to reach us is shown as exactly that, and never as having run
 * out. The two look the same from here and mean opposite things.
 */

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * Teal while there is room, gold once the limit is close.
 *
 * Gold is this app's one accent and there is no red in the palette, so being
 * over the limit is said in words rather than in a colour nobody would read
 * correctly anyway.
 */
function barColour(fraction: number): string {
  return fraction >= 0.8 ? "var(--color-pulpitry-gold)" : "var(--color-pulpitry-teal)";
}

export function HostedSubscription({
  onActivationChange,
}: {
  /** So the engine picker can offer -- or stop offering -- the hosted option. */
  onActivationChange: (activated: boolean) => void;
}) {
  const [state, setState] = useState<HostedView | null>(null);
  const [licence, setLicence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (next: HostedView) => {
    setState(next);
    onActivationChange(next.activated);
  };

  useEffect(() => {
    let live = true;
    void hostedStatus()
      .then((next) => {
        if (live) apply(next);
      })
      .catch(() => {
        // Settings must open whatever the network is doing.
        if (live) setState({ activated: false, entitlement: null, notice: null });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      apply(await hostedActivate(licence));
      setLicence("");
    } catch (err) {
      // Worded by the broker for this moment: whether the key is wrong, the
      // seats are used up, or the subscription has ended.
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    setBusy(true);
    setError(null);
    try {
      apply(await hostedDeactivate());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (state === null) {
    return <p className="text-[11.5px] text-pulpitry-muted">Checking your subscription…</p>;
  }

  if (!state.activated) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-pulpitry-muted">Licence key</span>
          <div className="flex gap-2">
            <input
              value={licence}
              spellCheck={false}
              autoComplete="off"
              placeholder="From your invoice"
              onChange={(event) => setLicence(event.target.value)}
              onKeyDown={(event) => {
                // Enter here must not submit the settings form around it.
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (licence.trim() && !busy) void activate();
                }
              }}
              className={`min-w-0 flex-1 font-mono tracking-wide ${FIELD}`}
            />
            <button
              type="button"
              disabled={busy || licence.trim().length === 0}
              onClick={() => void activate()}
              className="rounded border border-pulpitry-line px-3 py-2 text-[12.5px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
            >
              {busy ? "Activating…" : "Activate"}
            </button>
          </div>
        </label>
        {error ? (
          <p role="alert" className="text-[11.5px] leading-snug text-pulpitry-gold">
            {error}
          </p>
        ) : (
          <p className="text-[11.5px] leading-snug text-pulpitry-muted">
            Transcribe on our account instead of buying an Azure one. Type the key the way it
            is written; spacing and capitals do not matter.
          </p>
        )}
      </div>
    );
  }

  const plan = state.entitlement;

  return (
    <div className="flex flex-col gap-2">
      {plan ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-pulpitry-text">
              {plan.speechRemaining === "none left" ? "No hours left" : `${plan.speechRemaining} left`}
            </span>
            <span className="text-[11.5px] tabular-nums text-pulpitry-muted">
              renews {day.format(new Date(plan.periodEndsAt))}
            </span>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-pulpitry-raised">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, plan.usedFraction * 100)}%`,
                backgroundColor: barColour(plan.usedFraction),
              }}
            />
          </div>

          {/* Where the hours went. One plan covers both apps, so without this
              an operator cannot tell which of them spent them. */}
          {Object.keys(plan.byApp).length > 0 ? (
            <p className="text-[11.5px] text-pulpitry-muted">
              {Object.entries(plan.byApp)
                .filter(([, seconds]) => seconds > 0)
                .map(([app, seconds]) => `${app}: ${Math.round(seconds / 360) / 10} hr`)
                .join(" · ")}
            </p>
          ) : null}

          {plan.status !== "active" ? (
            <p role="alert" className="text-[11.5px] leading-snug text-pulpitry-gold">
              This subscription is {plan.status}. Transcription will not start until it is
              renewed.
            </p>
          ) : plan.warnAt ? (
            <p className="text-[11.5px] leading-snug text-pulpitry-muted">
              {Math.round(plan.warnAt * 100)}% of this month&rsquo;s hours are used. More can be
              added at any time, and this machine can always fall back to transcribing locally.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[11.5px] leading-snug text-pulpitry-muted">
          {/* Activated, but we could not ask how much is left. Saying so beats
              showing a zero that would read as having run out. */}
          {state.notice ?? "Could not check how many hours are left."}
        </p>
      )}

      {error ? (
        <p role="alert" className="text-[11.5px] leading-snug text-pulpitry-gold">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={() => void deactivate()}
        className="self-start rounded px-1 py-0.5 text-[11.5px] text-pulpitry-muted transition-colors hover:text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
      >
        {busy ? "Working…" : "Remove this subscription from this machine"}
      </button>
    </div>
  );
}
