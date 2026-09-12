import { useEffect, useState } from "react";

import {
  describeError,
  getSettings,
  saveSettings,
  type Output,
  type SettingsView,
} from "../lib/api";
import { DEFAULT_THEME } from "../lib/theme";
import type { LiveContent, Ticker } from "../lib/projector";
import { OutputsPanel } from "./OutputsPanel";
import { StageControls } from "./StageControls";

/**
 * Every congregation-facing screen, in one place.
 *
 * # Why this is not a page in Settings
 *
 * It was, and it was in the wrong shape twice over. Settings is where a church
 * decides how the application behaves and then leaves it alone for months;
 * this is opened during a service, when a projector has to be moved to another
 * screen, a feed switched on for a video team, or a timer started for whoever
 * is about to speak. Those are not the same kind of act and they should not be
 * the same distance from the operator's hand.
 *
 * It also replaces four controls in the title bar -- two screen pickers and
 * two buttons -- which could open the projector and the second display and
 * tell them nothing else. Everything an output can now be told was unreachable
 * for exactly the two outputs every church already had.
 */
export function OutputsDialog({
  settings,
  live,
  ticker,
  onClose,
  onSaved,
}: {
  settings: SettingsView;
  /** What is on the screens now, so each output can be previewed drawing it. */
  live: LiveContent | null;
  ticker: Ticker;
  onClose: () => void;
  onSaved: (settings: SettingsView) => void;
}) {
  const [outputs, setOutputs] = useState<Output[]>(settings.outputs ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /*
   * Saved as it is changed, not on a button.
   *
   * A dialog opened mid-service to move a screen is one somebody closes by
   * pressing Escape the moment the screen moves. A Save button there is a
   * setting lost, and the setting they lose is the one they were in a hurry
   * about.
   */
  useEffect(() => {
    if (outputs === settings.outputs) return;
    const timer = window.setTimeout(() => {
      void saveSettings({ ...settings, outputs })
        .then(onSaved)
        .catch((err) => setError(describeError(err)));
    }, 300);
    return () => window.clearTimeout(timer);
    // `settings` deliberately absent: it changes as a result of saving, and
    // depending on it would save again in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputs]);

  // Settings saved elsewhere -- a template renamed, an engine changed -- reach
  // this while it is open. Taking them wholesale would discard an edit in
  // progress, so only a list this dialog has not touched is adopted.
  useEffect(() => {
    void getSettings()
      .then((fresh) =>
        setOutputs((held) => (held.length ? held : fresh.outputs)),
      )
      .catch(() => undefined);
  }, []);

  return (
    <div
      data-dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-[720px] flex-col rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl">
        <header className="flex shrink-0 items-baseline justify-between border-b border-pulpitry-line px-5 py-3.5">
          <h2 className="text-[15px] text-pulpitry-text">Display outputs</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="mb-3 rounded border border-pulpitry-line px-3 py-2 text-[12px] text-pulpitry-gold">
              {error}
            </p>
          ) : null}

          <p className="mb-4 text-[11.5px] leading-snug text-pulpitry-muted">
            Every screen shows the same verse at the same moment. What differs
            is the look, the translation, the shape it is drawn in, and where it
            goes.
          </p>

          <OutputsPanel
            outputs={outputs}
            onChange={setOutputs}
            theme={settings.projector ?? DEFAULT_THEME}
            onError={setError}
            live={live}
            ticker={ticker}
          />

          <div className="mt-6 border-t border-pulpitry-line pt-4">
            <h3 className="mb-1 text-[13px] text-pulpitry-text">
              The platform&rsquo;s own screen
            </h3>
            <p className="mb-3 text-[11.5px] leading-snug text-pulpitry-muted">
              The timer, and a line the desk can send the platform. Shown only
              on an output whose shape is Stage display, and never anywhere a
              congregation can see.
            </p>
            <StageControls />
          </div>
        </div>
      </div>
    </div>
  );
}
