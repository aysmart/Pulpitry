import { useEffect, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import {
  describeError,
  hostedActivate,
  hostedDeactivate,
  hostedPortal,
  hostedStatus,
  type HostedView,
} from "../lib/api";

/**
 * The Castavox subscription, in Settings.
 *
 * A church on a plan transcribes on our account instead of opening one.
 * What this needs from the operator is a licence key, once per machine; what it
 * owes them afterwards is a straight answer about how many hours are left,
 * because that is the number that decides whether Sunday works.
 *
 * Being unable to reach us is shown as exactly that, and never as having run
 * out. The two look the same from here and mean opposite things.
 */

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

/*
 * The renewal date, with the year on it.
 *
 * "renews 14 Aug" is a date an operator reads as this week. Once a plan can be
 * bought for a year that is off by twelve months, and the way a church finds
 * out is by budgeting for the wrong month. The year costs four characters.
 */
const day = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Teal while there is room, gold once the limit is close.
 *
 * Gold is this app's one accent and there is no red in the palette, so being
 * over the limit is said in words rather than in a colour nobody would read
 * correctly anyway.
 */
function barColour(fraction: number): string {
  return fraction >= 0.8
    ? "var(--color-pulpitry-gold)"
    : "var(--color-pulpitry-teal)";
}

export function HostedSubscription({
  onActivationChange,
}: {
  /** So the engine picker can offer -- or stop offering -- the hosted option. */
  onActivationChange: (activated: boolean) => void;
}) {
  const [state, setState] = useState<HostedView | null>(null);
  const [licence, setLicence] = useState("");
  const [opening, setOpening] = useState(false);
  const [portalNote, setPortalNote] = useState<string | null>(null);

  /*
   * Opens the subscription page in the church's own browser.
   *
   * Their browser rather than a window here, deliberately: they will want to
   * read a code out of their mail, and possibly pay. Neither belongs in a
   * projection application, and a checkout inside one is a thing nobody should
   * be asked to trust.
   */
  const openPortal = async () => {
    setOpening(true);
    setPortalNote(null);
    try {
      const found = await hostedPortal();
      await openUrl(found.url);
      setPortalNote(
        found.sentTo
          ? `A code is on its way to ${found.sentTo}. Type it into the page that just opened.`
          : "A code is on its way to the address on the account.",
      );
    } catch (error) {
      setPortalNote(describeError(error));
    } finally {
      setOpening(false);
    }
  };
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
        if (live)
          setState({ activated: false, entitlement: null, notice: null });
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
    return (
      <p className="text-[11.5px] text-pulpitry-muted">
        Checking your subscription…
      </p>
    );
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
          <p
            role="alert"
            className="text-[11.5px] leading-snug text-pulpitry-gold"
          >
            {error}
          </p>
        ) : (
          <p className="text-[11.5px] leading-snug text-pulpitry-muted">
            Transcribe on our account instead of buying an Azure one. Type the
            key the way it is written; spacing and capitals do not matter.
          </p>
        )}
      </div>
    );
  }

  const plan = state.entitlement;

  /*
   * Every current plan is unlimited, and a meter is the wrong shape for one.
   *
   * The allowance arrives as a number nothing can reach, which keeps the
   * arithmetic honest everywhere it is compared — but drawn here it became a
   * progress bar pinned at zero and the words "1000000 hr left", which is not a
   * promise anybody made and reads as a fault.
   *
   * So when it is unlimited we say the word and drop the bar. What replaces it
   * is the figure that is still worth knowing: how much has been used. That is
   * the number an operator wants at the end of a month, and the only one the
   * bar was ever really carrying.
   */
  const unlimited = plan?.speechRemaining === "Unlimited";

  return (
    <div className="flex flex-col gap-2">
      {plan ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-pulpitry-text">
              {plan.speechRemaining === "none left"
                ? "No hours left"
                : unlimited
                  ? "Unlimited transcription"
                  : `${plan.speechRemaining} left`}
            </span>
            <span className="text-[11.5px] tabular-nums text-pulpitry-muted">
              renews {day.format(new Date(plan.periodEndsAt))}
            </span>
          </div>

          {/*
            Which subscription this machine is on.
            
            A church with two -- one they are leaving and one they have just
            bought -- had no way to tell them apart from the desk, and a
            machine left on the wrong one shows nothing but somebody else's
            numbers. It is also where a sign-in code goes, so seeing it here
            means never guessing which mailbox to open.
          */}
          {plan.email ? (
            <p className="text-[11.5px] leading-snug text-pulpitry-muted">
              {plan.accountName ? `${plan.accountName} — ` : ""}
              <span className="text-pulpitry-text">{plan.email}</span>
            </p>
          ) : null}

          {unlimited ? null : (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-pulpitry-raised">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, plan.usedFraction * 100)}%`,
                  backgroundColor: barColour(plan.usedFraction),
                }}
              />
            </div>
          )}

          {/* Where the hours went. One plan covers both apps, so without this
              an operator cannot tell which of them spent them. */}
          {Object.keys(plan.byApp).length > 0 ? (
            <p className="text-[11.5px] text-pulpitry-muted">
              {Object.entries(plan.byApp)
                .filter(([, seconds]) => seconds > 0)
                .map(
                  ([app, seconds]) =>
                    `${app}: ${Math.round(seconds / 360) / 10} hr`,
                )
                .join(" · ")}
            </p>
          ) : null}

          {plan.status !== "active" ? (
            <>
              <p
                role="alert"
                className="text-[11.5px] leading-snug text-pulpitry-gold"
              >
                This subscription is {plan.status}. Transcription will not start
                until it is renewed.
              </p>

              {/*
                The one case a church cannot get out of from the desk.
                
                The page that could fix this wants a licence key, and the key
                is on a machine in the office or an invoice from eight months
                ago. This opens the page for them and sends a code to the
                address on the account — the check still happens, the typing
                does not.
              */}
              <button
                type="button"
                onClick={() => void openPortal()}
                disabled={opening}
                className="self-start rounded border border-pulpitry-gold-dim bg-pulpitry-gold/10 px-2.5 py-1.5 text-[12px] text-pulpitry-gold transition-colors hover:border-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
              >
                {opening ? "Opening…" : "Renew this subscription"}
              </button>

              {portalNote ? (
                <p className="text-[11px] leading-snug text-pulpitry-muted">
                  {portalNote}
                </p>
              ) : null}
            </>
          ) : plan.warnAt ? (
            <p className="text-[11.5px] leading-snug text-pulpitry-muted">
              {Math.round(plan.warnAt * 100)}% of this month&rsquo;s hours are
              used. This machine can always fall back to transcribing locally,
              which is free and unlimited.
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
        <p
          role="alert"
          className="text-[11.5px] leading-snug text-pulpitry-gold"
        >
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
