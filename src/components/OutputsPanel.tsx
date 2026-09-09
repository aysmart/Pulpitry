import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { catalogList, type Item } from "../lib/catalog";
import type { Output } from "../lib/api";
import { libraryStatus, type Translation } from "../lib/bible";
import { listDisplays, type Display } from "../lib/projector";
import { OVERLAY_FORMS } from "../lib/overlays";

/**
 * The formats a switcher actually expects.
 *
 * Offered rather than typed, because a resolution nobody at the far end can
 * take is a black feed with nothing to say about itself. 1080p30 leads: it is
 * what most church switchers are set to and it halves the bandwidth of 60.
 */
const FORMATS: Array<{
  label: string;
  width: number;
  height: number;
  fps: number;
}> = [
  { label: "1920 × 1080 / 30", width: 1920, height: 1080, fps: 30 },
  { label: "1920 × 1080 / 60", width: 1920, height: 1080, fps: 60 },
  { label: "1280 × 720 / 30", width: 1280, height: 720, fps: 30 },
  { label: "1280 × 720 / 60", width: 1280, height: 720, fps: 60 },
  { label: "3840 × 2160 / 30", width: 3840, height: 2160, fps: 30 },
];

/**
 * The congregation-facing outputs, and what each of them shows.
 *
 * # Why this exists
 *
 * There were two windows, deliberately identical: the same look, the same
 * translation, the same everything, so a change to one could not be forgotten
 * in the other. That is right for a church with a screen and a spare, and
 * wrong the moment they have a stream wanting a lower third, a main wall
 * wanting full cards, and an overflow room reading a different translation.
 *
 * So the sameness moved down a level. Every output shows the same verse at the
 * same moment — two outputs disagreeing about what is live is the one failure
 * this cannot have — and each draws it however it was told to.
 *
 * # An output with no screen is a real arrangement
 *
 * A church whose switcher is on the network needs a feed, not a monitor. Such
 * an output is an ordinary window placed off the desktop: still drawn, still
 * captured, simply never looked at. The row says so rather than leaving "no
 * screen" to read as a mistake.
 */

interface OutputState {
  id: string;
  open: boolean;
}

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text focus-visible:focus-ring";

/** Enough to be unique for the life of an installation, and short to read. */
function freshId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function OutputsPanel({
  outputs,
  onChange,
}: {
  outputs: Output[];
  onChange: (outputs: Output[]) => void;
}) {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [templates, setTemplates] = useState<Item[]>([]);
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [live, setLive] = useState<OutputState[]>([]);

  const refreshLive = useCallback(() => {
    void invoke<OutputState[]>("outputs_state")
      .then(setLive)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void listDisplays()
      .then(setDisplays)
      .catch(() => undefined);
    void catalogList("template")
      .then(setTemplates)
      .catch(() => undefined);
    void libraryStatus()
      .then((status) => setTranslations(status.translations))
      .catch(() => undefined);
    refreshLive();
  }, [refreshLive]);

  const update = (id: string, change: Partial<Output>) =>
    onChange(
      outputs.map((output) =>
        output.id === id ? { ...output, ...change } : output,
      ),
    );

  const add = () =>
    onChange([
      ...outputs,
      {
        id: freshId(),
        name: `Output ${outputs.length + 2}`,
        template: "",
        translation: "",
        // No screen by default. Claiming a monitor unasked is how an output
        // ends up on the wall mid-service; the operator chooses where it goes.
        display: null,
        ndiEnabled: false,
        ndiName: "",
        width: 1920,
        height: 1080,
        fps: 30,
        // A lower third by default, because an output somebody adds by hand is
        // nearly always the one going to the switcher -- and a full-screen
        // second copy of the projector is what they already had.
        overlay: "lower-third",
      },
    ]);

  const remove = (id: string) => {
    // Closed before it is forgotten: a window whose settings are gone can no
    // longer be reached from this pane and would sit on a screen for ever.
    void invoke("close_output", { id }).catch(() => undefined);
    onChange(outputs.filter((output) => output.id !== id));
  };

  return (
    <div className="flex flex-col gap-4">
      {outputs.length === 0 ? (
        <p className="text-[11.5px] leading-snug text-pulpitry-muted">
          The projector and the second display show the same thing in the same
          look, which is what most churches want. Add an output here when one
          screen needs something different — a lower third for the stream, or a
          room reading another translation.
        </p>
      ) : null}

      {outputs.map((output) => {
        const state = live.find((entry) => entry.id === output.id);
        return (
          <div
            key={output.id}
            className="flex flex-col gap-2.5 rounded border border-pulpitry-line p-3"
          >
            <div className="flex items-center gap-2">
              <input
                value={output.name}
                onChange={(event) =>
                  update(output.id, { name: event.target.value })
                }
                placeholder="Foyer"
                className={`flex-1 ${FIELD}`}
              />
              <button
                type="button"
                onClick={() => {
                  const command = state?.open ? "close_output" : "open_output";
                  void invoke(command, { id: output.id })
                    .then(refreshLive)
                    .catch(() => undefined);
                }}
                className="rounded border border-pulpitry-line px-2 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold focus-visible:focus-ring"
              >
                {state?.open ? "Close" : "Open"}
              </button>
              <button
                type="button"
                onClick={() => remove(output.id)}
                className="rounded px-2 py-1.5 text-[12px] text-pulpitry-muted transition-colors hover:text-pulpitry-gold focus-visible:focus-ring"
              >
                Remove
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              <label className="flex min-w-[9rem] flex-1 flex-col gap-1">
                <span className="text-[11px] text-pulpitry-muted">Look</span>
                <select
                  value={output.template}
                  onChange={(event) =>
                    update(output.id, { template: event.target.value })
                  }
                  className={FIELD}
                >
                  <option value="">Same as the Display pane</option>
                  {templates.map((template) => (
                    <option key={template.id} value={String(template.id)}>
                      {template.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex min-w-[9rem] flex-1 flex-col gap-1">
                <span className="text-[11px] text-pulpitry-muted">
                  Translation
                </span>
                <select
                  value={output.translation}
                  onChange={(event) =>
                    update(output.id, { translation: event.target.value })
                  }
                  className={FIELD}
                >
                  <option value="">Same as the Scripture panel</option>
                  {translations.map((translation) => (
                    <option key={translation.id} value={translation.id}>
                      {translation.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex min-w-[9rem] flex-1 flex-col gap-1">
                <span className="text-[11px] text-pulpitry-muted">Screen</span>
                <select
                  value={output.display === null ? "" : String(output.display)}
                  onChange={(event) =>
                    update(output.id, {
                      display:
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                    })
                  }
                  className={FIELD}
                >
                  <option value="">None — on the network only</option>
                  {displays.map((display) => (
                    <option key={display.index} value={String(display.index)}>
                      {display.name} ({display.width}×{display.height})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <label className="flex min-w-[11rem] flex-1 flex-col gap-1">
                <span className="text-[11px] text-pulpitry-muted">Shape</span>
                <select
                  value={output.overlay || "none"}
                  onChange={(event) =>
                    update(output.id, { overlay: event.target.value })
                  }
                  className={FIELD}
                >
                  {OVERLAY_FORMS.map((form) => (
                    <option key={form.id} value={form.id}>
                      {form.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex min-w-[9rem] flex-1 flex-col gap-1">
                <span className="text-[11px] text-pulpitry-muted">Format</span>
                <select
                  value={`${output.width}x${output.height}@${output.fps}`}
                  onChange={(event) => {
                    const chosen = FORMATS.find(
                      (format) =>
                        `${format.width}x${format.height}@${format.fps}` ===
                        event.target.value,
                    );
                    if (chosen) {
                      update(output.id, {
                        width: chosen.width,
                        height: chosen.height,
                        fps: chosen.fps,
                      });
                    }
                  }}
                  className={FIELD}
                >
                  {FORMATS.map((format) => (
                    <option
                      key={format.label}
                      value={`${format.width}x${format.height}@${format.fps}`}
                    >
                      {format.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* What the chosen shape actually does, said where it is chosen.
                "Lower third" is not self-explanatory to a volunteer, and the
                difference between a picture and something keyable is the whole
                reason this pane exists. */}
            <p className="text-[11px] leading-snug text-pulpitry-muted">
              {OVERLAY_FORMS.find(
                (form) => form.id === (output.overlay || "none"),
              )?.hint ?? ""}
              {output.overlay && output.overlay !== "none"
                ? " Sent with a transparent background, so a switcher can lay it over a camera."
                : ""}
            </p>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={output.ndiEnabled}
                onChange={(event) =>
                  update(output.id, { ndiEnabled: event.target.checked })
                }
                className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
              />
              <span className="text-[12.5px] text-pulpitry-text">
                Send this on the network
              </span>
            </label>

            {output.ndiEnabled ? (
              <input
                value={output.ndiName}
                onChange={(event) =>
                  update(output.id, { ndiName: event.target.value })
                }
                placeholder={`Pulpitry — ${output.name || "Output"}`}
                className={FIELD}
              />
            ) : null}

            {/* Said where it is chosen. A church learning during a service that
                three feeds do not fit down their wifi is the failure this
                sentence exists to prevent. */}
            {output.display === null ? (
              <p className="text-[11px] leading-snug text-pulpitry-muted">
                Drawn at {output.width}×{output.height} and never shown on a
                screen. Only useful with NDI switched on below — and each feed
                is around 100 Mbit/s, so this is for a wired network.
              </p>
            ) : null}
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        className="self-start rounded border border-pulpitry-line px-2.5 py-1.5 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold focus-visible:focus-ring"
      >
        Add an output
      </button>
    </div>
  );
}
