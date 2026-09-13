import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { catalogList, newItem, type Item } from "../lib/catalog";
import type { Output } from "../lib/api";
import { libraryStatus, type Translation } from "../lib/bible";
import {
  listDisplays,
  type Display,
  type LiveContent,
  type Ticker,
} from "../lib/projector";
import { OVERLAY_FORMS, type OverlayForm } from "../lib/overlays";
import {
  formFor,
  listShapes,
  onShapeChanged,
  shapeFromForm,
  shapeIdOf,
} from "../lib/shapes";
import { ShapeStudio } from "./ShapeStudio";
import type { ProjectorTheme } from "../lib/theme";
import { OutputPreview } from "./OutputPreview";

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
  /** On the network right now. */
  sending: boolean;
  /** Why it is not, when it was asked to be. */
  problem: string | null;
}

/** What the network would call an output's feed. */
function feedName(output: Output): string {
  return output.ndiName.trim() || `Pulpitry — ${output.name.trim() || "Output"}`;
}

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text focus-visible:focus-ring";

/**
 * The two outputs that cannot be removed.
 *
 * The projector and the second display are seated in this list on every
 * launch, so that everything an output can be told reaches them too. A list
 * with no way to reach the projector would be worse than the title-bar buttons
 * it replaced, so neither can be deleted -- only switched off by giving it no
 * screen and no feed.
 */
const RESERVED = ["main", "second"];

/** Enough to be unique for the life of an installation, and short to read. */
function freshId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function OutputsPanel({
  outputs,
  onChange,
  theme,
  live,
  ticker,
  onError,
}: {
  outputs: Output[];
  onChange: (outputs: Output[]) => void;
  /** The shared look, for an output with no template of its own. */
  theme: ProjectorTheme;
  /** What is on the screens now, so each preview shows it. */
  live: LiveContent | null;
  onError: (message: string) => void;
  ticker: Ticker;
}) {
  const [displays, setDisplays] = useState<Display[]>([]);
  const [templates, setTemplates] = useState<Item[]>([]);
  /** The shapes this church has drawn, and the one open in the studio. */
  const [shapes, setShapes] = useState<Item[]>([]);
  const [designing, setDesigning] = useState<Item | null>(null);
  /** Which output opened it, so what is drawn lands on that output. */
  const [designingFor, setDesigningFor] = useState<string | null>(null);

  /**
   * Whether a freshly read list says anything new.
   *
   * By value, because these are re-read on a timer and every read hands back
   * new objects. Comparing them is cheaper than re-rendering a pane of live
   * previews twice a second for an answer that has not changed.
   */
  const same = <T,>(held: T[], found: T[]) =>
    JSON.stringify(held) === JSON.stringify(found);

  /** Re-read after the studio saves or deletes, so the picker is current. */
  const refreshShapes = () => {
    void listShapes()
      .then(setShapes)
      .catch(() => undefined);
  };
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [states, setStates] = useState<OutputState[]>([]);

  /*
   * What the network can see, asked for rather than polled, per output.
   *
   * "Is anybody able to see this?" is the one question an operator has about
   * a feed, and the honest answer comes from discovery rather than from us
   * saying we are sending. A source we announce that this machine cannot find
   * is a network that will not carry it -- guest wifi with client isolation, a
   * VLAN, a firewall -- which is worth finding out on a Tuesday.
   */
  const [seen, setSeen] = useState<Record<string, string[] | "looking">>({});

  const refreshLive = useCallback(() => {
    void invoke<OutputState[]>("outputs_state")
      .then(setStates)
      .catch(() => undefined);
  }, []);

  /*
   * Kept current while the dialog is open.
   *
   * A feed starts after the window appears and after a save lands, both
   * behind the button that caused them, and can fail seconds later -- a Mac
   * waiting on Screen Recording, a runtime not installed. Asked once, the row
   * would say "starting" for ever.
   */
  useEffect(() => {
    const timer = window.setInterval(refreshLive, 2000);
    return () => window.clearInterval(timer);
  }, [refreshLive]);

  const lookFor = (id: string) => {
    setSeen((current) => ({ ...current, [id]: "looking" }));
    void invoke<string[]>("ndi_sources")
      .catch(() => [] as string[])
      .then((sources) => setSeen((current) => ({ ...current, [id]: sources })));
  };

  /*
   * The lists this pane chooses from, kept current while it is open.
   *
   * They were read once, when the pane appeared, and a pane that is open for
   * twenty minutes while somebody sets a church up is exactly where that
   * fails: a projector is plugged in and its screen is not in the list, a look
   * is saved next door and the Look picker has never heard of it, a shape is
   * drawn and the output that was drawn for cannot be pointed at it. Closing
   * and reopening the pane fixed all three, which is a thing an operator
   * should never have to learn.
   *
   * A shape says when it changes, so that one is told rather than asked. The
   * monitors and the looks have nothing to say for themselves -- there is no
   * event for a screen being plugged in -- so they are re-read on the same
   * two-second tick that keeps the feeds honest, and the state is only
   * replaced when the answer is actually different: a new array every two
   * seconds would re-render every preview in the pane for nothing.
   */
  useEffect(() => {
    const read = () => {
      void listDisplays()
        .then((found) => setDisplays((held) => (same(held, found) ? held : found)))
        .catch(() => undefined);
      void catalogList("template")
        .then((found) => setTemplates((held) => (same(held, found) ? held : found)))
        .catch(() => undefined);
    };

    read();
    const timer = window.setInterval(read, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshShapes();
    const stop = onShapeChanged(refreshShapes);
    return () => {
      void stop.then((unlisten) => unlisten());
    };
    // Once, for the life of the pane. `refreshShapes` is rebuilt on every
    // render and does the same thing each time, so listing it here would
    // resubscribe on every keystroke in the pane above.
  }, []);

  useEffect(() => {
    void libraryStatus()
      .then((status) => setTranslations(status.translations))
      .catch(() => undefined);
    refreshLive();
  }, [refreshLive]);

  /**
   * The look one output draws with, resolved here rather than fetched.
   *
   * `theme_for_window` answers the same question in the backend, from the
   * settings on disk -- which this dialog has not written yet, because it
   * saves a moment after each change. A preview a beat behind the dropdown
   * that changed it is worse than no preview, so the template's own theme is
   * read from the catalog list the Look picker is already using.
   */
  const themeFor = (output: Output): ProjectorTheme => {
    if (!output.template) return theme;
    const item = templates.find((held) => String(held.id) === output.template);
    return item?.body.kind === "template" ? item.body.theme : theme;
  };

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
        // A lower third is the default shape, and a lower third is nearly
        // always capitals.
        uppercase: true,
        stageClock: true,
        stageLive: true,
      },
    ]);

  /**
   * Which output has been asked to cover the desk and not yet answered.
   *
   * One at a time, cleared as soon as the button loses focus: an armed button
   * somebody walked away from should not still be armed when they come back to
   * the pane looking for something else.
   */
  const [arming, setArming] = useState<string | null>(null);

  /** Whether opening this output would cover the screen the desk is on. */
  const coversDesk = (output: Output) =>
    displays.some(
      (display) => display.index === output.display && display.isDesk,
    );

  const remove = (id: string) => {
    // Closed before it is forgotten: a window whose settings are gone can no
    // longer be reached from this pane and would sit on a screen for ever.
    void invoke("close_output", { id }).catch(() => undefined);
    onChange(outputs.filter((output) => output.id !== id));
  };

  return (
    <div className="flex flex-col gap-4">
      {outputs.map((output) => {
        const state = states.find((entry) => entry.id === output.id);
        return (
          <div
            key={output.id}
            data-tour="output-row"
            className="flex gap-3 rounded border border-pulpitry-line p-3"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
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
                    if (state?.open) {
                      void invoke("close_output", { id: output.id })
                        .then(refreshLive)
                        .catch(() => undefined);
                      return;
                    }
                    /*
                      Asked before it happens, on the one screen where opening
                      looks like a fault.

                      An output is borderless, always on top and fills the
                      display, and its pointer is hidden because nobody points
                      at a projector. Sent to the operator's own screen -- the
                      usual case on a laptop with nothing plugged into it --
                      every one of those decisions reads as the application
                      having frozen. The window itself now keeps its pointer and
                      says how to leave; this is the half that can still be
                      reconsidered.

                      The button asks rather than a dialog box, because the
                      question is about the button: two presses, and the second
                      one is the answer.
                    */
                    if (coversDesk(output) && arming !== output.id) {
                      setArming(output.id);
                      return;
                    }
                    setArming(null);
                    void invoke("open_output", { id: output.id })
                      .then(refreshLive)
                      .catch(() => undefined);
                  }}
                  onBlur={() => setArming(null)}
                  title={
                    coversDesk(output)
                      ? "This screen is the one you are working on. The output will cover it; press Esc on it to close it again."
                      : undefined
                  }
                  className={`rounded border px-2 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
                    arming === output.id
                      ? "border-pulpitry-gold text-pulpitry-gold"
                      : "border-pulpitry-line text-pulpitry-text hover:border-pulpitry-gold"
                  }`}
                >
                  {state?.open
                    ? "Close"
                    : arming === output.id
                      ? "Cover this screen?"
                      : "Open"}
                </button>
                {RESERVED.includes(output.id) ? null : (
                  <button
                    type="button"
                    onClick={() => remove(output.id)}
                    className="rounded px-2 py-1.5 text-[12px] text-pulpitry-muted transition-colors hover:text-pulpitry-gold focus-visible:focus-ring"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <label
                  data-tour="output-look"
                  className="flex min-w-[9rem] flex-1 flex-col gap-1"
                >
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

                <label
                  data-tour="output-screen"
                  className="flex min-w-[9rem] flex-1 flex-col gap-1"
                >
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
                        {/* An output fills a screen and stays on top, so this
                            one hides the desk. Allowed -- at home there is only
                            this screen -- but never a surprise. */}
                        {display.isDesk ? " — the screen you are working on" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <label
                  data-tour="output-shape"
                  className="flex min-w-[11rem] flex-1 flex-col gap-1"
                >
                  <span className="text-[11px] text-pulpitry-muted">Shape</span>
                  <select
                    value={output.overlay || "none"}
                    onChange={(event) =>
                      update(output.id, { overlay: event.target.value })
                    }
                    className={FIELD}
                  >
                    {/*
                      Three kinds of answer, and the first two are not shapes
                      at all.

                      "Whole screen" is a projector: a background and the words
                      on it. "Stage display" is the platform's own screen, which
                      a congregation never sees. Everything below them is
                      furniture drawn on transparency for a switcher to key --
                      and the church's own comes first, because once they have
                      drawn one it is the one they mean.
                    */}
                    {OVERLAY_FORMS.filter((form) =>
                      ["none", "stage"].includes(form.id),
                    ).map((form) => (
                      <option key={form.id} value={form.id}>
                        {form.name}
                      </option>
                    ))}

                    {shapes.length > 0 ? (
                      <optgroup label="Your shapes">
                        {shapes.map((drawn) => (
                          <option key={drawn.id} value={formFor(drawn.id ?? 0)}>
                            {drawn.title}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}

                    {/*
                      Kept, and last.

                      Every one of these is now also a template in the shape
                      library, where it can be copied and moved -- but an output
                      can be pointed at the original with nothing drawn and
                      nothing saved, which is the right answer for a church that
                      wants a lower third and nothing to do with a studio. They
                      are also what every installation already using one is
                      pointed at, and a list that dropped them would show those
                      outputs as having no shape at all.
                    */}
                    <optgroup label="Without drawing one">
                      {OVERLAY_FORMS.filter(
                        (form) => !["none", "stage"].includes(form.id),
                      ).map((form) => (
                        <option key={form.id} value={form.id}>
                          {form.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>

                {/*
                  A way in, beside the choice it belongs to.

                  Editing the shape this output is drawing is the commonest
                  reason to open the studio -- it is being looked at right here,
                  in the preview underneath.
                */}
                <span className="flex items-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const id = shapeIdOf(output.overlay || "");
                      const existing =
                        id === null
                          ? null
                          : shapes.find((drawn) => drawn.id === id);
                      setDesigningFor(output.id);
                      setDesigning(
                        existing ?? {
                          /*
                           * Started from whatever this output is drawing now,
                           * rather than from the same band every time: an
                           * operator pressing this on a side panel wants a side
                           * panel to move, not a lower third to rebuild.
                           */
                          ...newItem("", {
                            kind: "overlay",
                            elements: shapeFromForm(output.overlay || ""),
                          }),
                        },
                      );
                    }}
                    title={
                      shapeIdOf(output.overlay || "") === null
                        ? "Draw a shape of your own: a band, a rule, your logo"
                        : "Change this shape"
                    }
                    className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[12px] text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold focus-visible:focus-ring"
                  >
                    {shapeIdOf(output.overlay || "") === null
                      ? "Draw one…"
                      : "Edit shape…"}
                  </button>
                </span>

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
                {/* A shape the church drew has no hint of ours to give: it is
                    theirs, and saying anything about how it looks would be
                    guessing at furniture we have never seen. Its name and the
                    preview underneath are the description. */}
                {shapeIdOf(output.overlay || "") !== null
                  ? `Your own shape${
                      shapes.find(
                        (drawn) => drawn.id === shapeIdOf(output.overlay || ""),
                      )
                        ? `, ${shapes.find((drawn) => drawn.id === shapeIdOf(output.overlay || ""))!.title}`
                        : " — which is no longer in the library, so this output draws nothing"
                    }.`
                  : (OVERLAY_FORMS.find(
                      (form) => form.id === (output.overlay || "none"),
                    )?.hint ?? "")}
                {output.overlay && output.overlay !== "none"
                  ? " Sent with a transparent background, so a switcher can lay it over a camera."
                  : ""}
                {/* Said here because it is a rule about this choice, and the
                    alternative is an operator watching a notice board go up in
                    the room and wondering why the stream did not change. A
                    slide is a layout -- a heading over a table, panels across
                    the frame -- and a band can hold a sentence. */}
                {output.overlay &&
                !["none", "stage"].includes(output.overlay)
                  ? " Slides pass it by: a slide is a whole screen, so it goes to the screens and this output keeps showing the camera."
                  : ""}
              </p>

              {/* A stage display is the one shape whose content is its own, so
                  it is the one shape with its own switches. Shown only there:
                  two dead checkboxes on every other output would teach an
                  operator to stop reading this pane. */}
              {output.overlay === "stage" ? (
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={output.stageLive}
                      onChange={(event) =>
                        update(output.id, { stageLive: event.target.checked })
                      }
                      className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                    />
                    <span className="text-[12.5px] text-pulpitry-text">
                      Show what is live
                    </span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={output.stageClock}
                      onChange={(event) =>
                        update(output.id, { stageClock: event.target.checked })
                      }
                      className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                    />
                    <span className="text-[12.5px] text-pulpitry-text">
                      Show the time of day
                    </span>
                  </label>
                </div>
              ) : null}

              {output.overlay === "stage" &&
              !output.stageLive &&
              !output.stageClock ? (
                <p className="text-[11px] leading-snug text-pulpitry-muted">
                  The timer alone, set as large as the screen allows — readable
                  from anywhere on the platform rather than only from the seat it
                  was aimed at.
                </p>
              ) : null}

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={output.uppercase}
                  onChange={(event) =>
                    update(output.id, { uppercase: event.target.checked })
                  }
                  className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                />
                <span className="text-[12.5px] text-pulpitry-text">
                  Set the words in capitals
                </span>
              </label>

              {/* Said once, where the choice is: a volunteer should not have to
                  know why a band and a wall want different answers. */}
              <p className="text-[11px] leading-snug text-pulpitry-muted">
                {output.uppercase
                  ? "Right for a short band read in a glance — capitals hold their shape against a moving picture."
                  : "Right for a screen carrying more than a line: capitals are slower to read in a paragraph."}
              </p>

              <label data-tour="output-feed" className="flex items-center gap-2">
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
                <>
                  <input
                    value={output.ndiName}
                    onChange={(event) =>
                      update(output.id, { ndiName: event.target.value })
                    }
                    placeholder={`Pulpitry — ${output.name || "Output"}`}
                    className={FIELD}
                  />
                  <FeedStatus
                    name={feedName(output)}
                    state={state}
                    seen={seen[output.id]}
                    onLook={() => lookFor(output.id)}
                  />
                </>
              ) : null}

              {/* Said where it is chosen. A church learning during a service that
                  three feeds do not fit down their wifi is the failure this
                  sentence exists to prevent. */}
              {output.display === null ? (
                <p className="text-[11px] leading-snug text-pulpitry-muted">
                  Drawn at {output.width}×{output.height} and never shown on a
                  screen. Only useful with NDI switched on above — and each feed
                  is around 100 Mbit/s, so this is for a wired network.
                </p>
              ) : null}
            </div>

            {/* Beside the controls rather than under them: it is what the
                controls are for, and an operator changing a shape should see
                the shape change without scrolling. */}
            <div data-tour="output-preview" className="hidden w-[190px] shrink-0 sm:block">
              <OutputPreview
                form={(output.overlay || "none") as OverlayForm}
                theme={themeFor(output)}
                captions={theme.showReference}
                translation={output.translation}
                uppercase={output.uppercase}
                stageClock={output.stageClock}
                stageLive={output.stageLive}
                live={live}
                ticker={ticker}
              />
            </div>
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

      {/* The studio, over this pane: a shape is drawn against the output that
          will draw it, with that output's preview underneath. */}
      {designing ? (
        <ShapeStudio
          shape={designing}
          theme={theme}
          onClose={() => {
            setDesigning(null);
            refreshShapes();
          }}
          onSaved={(saved) => {
            setDesigning(null);
            refreshShapes();
            /*
             * The output that opened the studio is pointed at what was just
             * drawn. Saving a shape and then having to choose it from a menu
             * would be asking twice for one decision.
             */
            if (saved.id !== null && designingFor) {
              update(designingFor, { overlay: formFor(saved.id) });
            }
          }}
          onError={onError}
        />
      ) : null}
    </div>
  );
}

/**
 * Whether a feed is on the network, and if it was asked to be and is not, why.
 *
 * The failures are the operator's to fix and were once only in the log: a Mac
 * that had not been given Screen Recording published nothing and said nothing,
 * which from the switcher looks exactly like a network fault.
 */
function FeedStatus({
  name,
  state,
  seen,
  onLook,
}: {
  name: string;
  state: OutputState | undefined;
  seen: string[] | "looking" | undefined;
  onLook: () => void;
}) {
  if (!state?.open) {
    return (
      <p className="text-[11px] leading-snug text-pulpitry-muted">
        Goes on the network as &ldquo;{name}&rdquo; while this output is open.
      </p>
    );
  }
  if (state.problem) {
    return (
      <p role="alert" className="text-[11.5px] leading-snug text-pulpitry-gold">
        {state.problem}
      </p>
    );
  }
  if (!state.sending) {
    return <p className="text-[11px] text-pulpitry-muted">Starting the feed…</p>;
  }

  // A source is listed as "MACHINE (name)", so the name is matched in brackets
  // rather than anywhere: "Pulpitry" alone is inside every one of ours.
  const found = Array.isArray(seen) && seen.some((source) => source.endsWith(`(${name})`));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11.5px] text-pulpitry-teal">
          On the network as &ldquo;{name}&rdquo;
        </span>
        <button
          type="button"
          disabled={seen === "looking"}
          onClick={onLook}
          className="rounded px-1 py-0.5 text-[11.5px] text-pulpitry-muted underline-offset-2 hover:underline disabled:opacity-60 focus-visible:focus-ring"
        >
          {seen === "looking" ? "Looking…" : "Check the network can see it"}
        </button>
      </div>
      {Array.isArray(seen) ? (
        found ? (
          <span className="text-[11.5px] text-pulpitry-teal">
            Found on the network. Any NDI software here can take it.
          </span>
        ) : (
          <span className="text-[11.5px] leading-snug text-pulpitry-gold">
            Sending, but this machine cannot find it on the network.
            {seen.length > 0
              ? " Other sources are visible, so NDI works — something is blocking this one."
              : " No NDI sources at all are visible, which usually means the network blocks discovery: guest wifi, client isolation, or a firewall."}
          </span>
        )
      ) : null}
    </div>

  );
}
