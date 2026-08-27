import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { MirrorPanel } from "./MirrorPanel";
import { NdiPanel } from "./NdiPanel";
import { HostedSubscription } from "./HostedSubscription";
import { NodeRuntimeNotice } from "./NodeRuntimeNotice";

import {
  clearAssistKey,
  clearAzureKey,
  describeError,
  hostedStatus,
  measureSpeech,
  saveAssistKey,
  saveAzureKey,
  saveSettings,
  speechModels,
  downloadSpeechModel,
  type HostedView,
  type ModelProgress,
  type SettingsView,
  type SpeechModel,
} from "../lib/api";

/** Azure Speech regions, by the identifier the SDK expects. */
const REGIONS = [
  "australiaeast",
  "brazilsouth",
  "canadacentral",
  "centralindia",
  "centralus",
  "eastasia",
  "eastus",
  "eastus2",
  "francecentral",
  "germanywestcentral",
  "japaneast",
  "koreacentral",
  "northeurope",
  "norwayeast",
  "southafricanorth",
  "southcentralus",
  "southeastasia",
  "swedencentral",
  "switzerlandnorth",
  "uaenorth",
  "uksouth",
  "westeurope",
  "westus",
  "westus2",
  "westus3",
];

/**
 * What can be spoken, and which engine can hear it.
 *
 * The three engines disagree, and a picker that hides that sells a church
 * something that produces nonsense: ask a Castavox subscription for Swahili and
 * it answers confidently in the wrong language. `hosted`, `azure` and `local`
 * say who can actually do each one.
 *
 * Yoruba and Hausa are local-only, which inverts the usual advice — for those
 * languages this machine is not the compromise, it is the only thing that
 * works. Igbo is heard by nothing and is deliberately not offered: its Bible is
 * bundled and searchable, but there is no engine to listen for it.
 *
 * Kept in step with castavox-core's `languages.rs`, which is the same table for
 * Castavox.
 */
const LANGUAGES = [
  {
    code: "en-US",
    label: "English (United States)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-GB",
    label: "English (United Kingdom)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-NG",
    label: "English (Nigeria)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-GH",
    label: "English (Ghana)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-KE",
    label: "English (Kenya)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-ZA",
    label: "English (South Africa)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-IN",
    label: "English (India)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-AU",
    label: "English (Australia)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "en-CA",
    label: "English (Canada)",
    hosted: true,
    azure: true,
    local: true,
  },
  { code: "yo-NG", label: "Yoruba", hosted: false, azure: false, local: true },
  { code: "ha-NG", label: "Hausa", hosted: false, azure: false, local: true },
  {
    code: "sw-KE",
    label: "Swahili (Kenya)",
    hosted: false,
    azure: true,
    local: true,
  },
  {
    code: "sw-TZ",
    label: "Swahili (Tanzania)",
    hosted: false,
    azure: true,
    local: true,
  },
  {
    code: "fr-FR",
    label: "French (France)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "fr-CA",
    label: "French (Canada)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "es-ES",
    label: "Spanish (Spain)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "es-MX",
    label: "Spanish (Mexico)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "pt-BR",
    label: "Portuguese (Brazil)",
    hosted: true,
    azure: true,
    local: true,
  },
  {
    code: "pt-PT",
    label: "Portuguese (Portugal)",
    hosted: true,
    azure: true,
    local: true,
  },
  { code: "de-DE", label: "German", hosted: true, azure: true, local: true },
  { code: "it-IT", label: "Italian", hosted: true, azure: true, local: true },
  { code: "nl-NL", label: "Dutch", hosted: true, azure: true, local: true },
  { code: "hi-IN", label: "Hindi", hosted: true, azure: true, local: true },
  { code: "ru-RU", label: "Russian", hosted: true, azure: true, local: true },
  { code: "ja-JP", label: "Japanese", hosted: true, azure: true, local: true },
  { code: "pl-PL", label: "Polish", hosted: true, azure: true, local: true },
  {
    code: "zh-CN",
    label: "Chinese (Mandarin)",
    hosted: false,
    azure: true,
    local: true,
  },
  { code: "ko-KR", label: "Korean", hosted: false, azure: true, local: true },
  {
    code: "ar-EG",
    label: "Arabic (Egypt)",
    hosted: false,
    azure: true,
    local: true,
  },
  { code: "am-ET", label: "Amharic", hosted: false, azure: true, local: true },
  {
    code: "af-ZA",
    label: "Afrikaans",
    hosted: false,
    azure: true,
    local: true,
  },
  { code: "zu-ZA", label: "Zulu", hosted: false, azure: true, local: false },
  { code: "tl-PH", label: "Tagalog", hosted: false, azure: true, local: true },
  {
    code: "id-ID",
    label: "Indonesian",
    hosted: false,
    azure: true,
    local: true,
  },
  {
    code: "uk-UA",
    label: "Ukrainian",
    hosted: false,
    azure: true,
    local: true,
  },
  { code: "ro-RO", label: "Romanian", hosted: false, azure: true, local: true },
  { code: "ta-IN", label: "Tamil", hosted: false, azure: true, local: true },
];

/**
 * What to say when the language and the engine disagree.
 *
 * Nothing in the ordinary case, which is most of them. When they do disagree it
 * names the engine that *would* work — "this cannot do Yoruba" leaves an
 * operator stuck, "use this machine instead" does not.
 */
function languageWarning(code: string, engine: string): string | null {
  const language = LANGUAGES.find((entry) => entry.code === code);
  if (!language) return null;

  const works =
    engine === "hosted"
      ? language.hosted
      : engine === "azure"
        ? language.azure
        : language.local;
  if (works) return null;

  const instead: string[] = [];
  if (language.local && engine !== "local") instead.push("this machine");
  if (language.azure && engine !== "azure")
    instead.push("your own Azure account");
  if (language.hosted && engine !== "hosted")
    instead.push("a Castavox subscription");

  const named =
    engine === "hosted"
      ? "A Castavox subscription"
      : engine === "azure"
        ? "Azure"
        : "This machine";

  return instead.length === 0
    ? `${named} cannot transcribe ${language.label}, and nor can the others. The Bible can still be searched and displayed in it; only listening is unavailable.`
    : `${named} cannot transcribe ${language.label}. Use ${instead.join(" or ")} instead.`;
}

/** Bytes as something a person can weigh against their own machine. */
function describeSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

/**
 * Where a setting lives, so an operator can learn it rather than hunt for it.
 *
 * Six named places beats one column you scroll, which is what this was while
 * there were six settings and stopped being once there was a scripture library
 * to put somewhere.
 *
 * Ranged left under a hanging rule rather than behind icons. Icons in a
 * settings rail are the most generic thing in desktop software -- every
 * application has the same little gear and speaker -- and the rule is the same
 * device the slide arrangements use, so this reads as part of the product
 * rather than as a settings screen bolted to it.
 */
const PANES = [
  {
    id: "account",
    name: "Account",
    note: "Your subscription, and the machines on it.",
  },
  {
    id: "scripture",
    name: "Scripture",
    note: "What the model may suggest, and how sure it must be.",
  },
  { id: "audio", name: "Audio", note: "Where the words come from." },
  {
    id: "stage",
    name: "Stage",
    note: "Where the picture goes, and who else follows it.",
  },
  { id: "usage", name: "Usage", note: "What this period has used." },
  {
    id: "help",
    name: "Help",
    note: "What leaves this machine, and what does not.",
  },
] as const;

type PaneId = (typeof PANES)[number]["id"];

function Rail({
  active,
  onChoose,
}: {
  active: PaneId;
  onChoose: (id: PaneId) => void;
}) {
  return (
    <nav className="flex w-[164px] shrink-0 flex-col gap-0.5 border-r border-pulpitry-line py-3">
      {PANES.map((pane) => {
        const chosen = pane.id === active;
        return (
          <button
            key={pane.id}
            type="button"
            onClick={() => onChoose(pane.id)}
            aria-current={chosen ? "page" : undefined}
            className={`flex flex-col gap-1 px-4 py-2 text-left transition-colors focus-visible:focus-ring ${
              chosen
                ? "text-pulpitry-text"
                : "text-pulpitry-muted hover:text-pulpitry-text"
            }`}
          >
            {/* The rule is the whole device: present on the chosen one, absent
                on the rest. No background, no pill -- a settings rail that
                highlights with a filled block reads as a tab bar. */}
            <span
              aria-hidden
              className={`h-[2px] w-5 rounded-full transition-colors ${
                chosen ? "bg-pulpitry-gold" : "bg-transparent"
              }`}
            />
            <span className="text-[13px]">{pane.name}</span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * One pane, mounted whether or not it is showing.
 *
 * Hidden rather than unmounted, and that is not a detail: the subscription
 * panel reports whether a licence is active, and the engine picker two panes
 * away needs that answer. Unmounting it would mean the answer only exists
 * while somebody is looking at Account.
 */
function Pane({
  id,
  active,
  children,
}: {
  id: PaneId;
  active: PaneId;
  children: React.ReactNode;
}) {
  return (
    <div className={id === active ? "flex flex-col gap-5" : "hidden"}>
      {children}
    </div>
  );
}

/**
 * What this period has used, for a church that wants to know before it runs out.
 *
 * Its own pane because it answers a question nobody could ask before: the
 * numbers existed on the subscription and were only ever shown as a single
 * remaining figure beside a licence key. "12 hr 30 min left" is the answer to
 * "can we get through Sunday"; it is not the answer to "where did the last
 * forty hours go", which is what a treasurer asks in January.
 */
function Usage() {
  const [state, setState] = useState<HostedView | null>(null);

  useEffect(() => {
    let live = true;
    hostedStatus()
      .then((next) => live && setState(next))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, []);

  const plan = state?.entitlement;

  if (!state?.activated || !plan) {
    return (
      <Section
        title="Usage"
        note="Nothing is metered without a subscription. Transcribing on this machine is unlimited and always has been."
      >
        <p className="text-[12.5px] leading-relaxed text-pulpitry-muted">
          There is no plan on this machine, so there is nothing here to count.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="This period"
      note="Hours are pooled across the applications and the machines on your plan."
    >
      <dl className="flex flex-col divide-y divide-pulpitry-line">
        <Row label="Transcription left" value={plan.speechRemaining} />
        {/* By application, because a pooled figure hides which of the two spent
            it -- and a church running both has no other way to find out. */}
        {Object.entries(plan.byApp).map(([app, seconds]: [string, number]) => (
          <Row
            key={app}
            label={app === "castavox" ? "Used by Castavox" : "Used by Pulpitry"}
            value={hours(seconds)}
            quiet
          />
        ))}
        <Row
          label="Period ends"
          value={new Date(plan.periodEndsAt).toLocaleDateString()}
        />
      </dl>
    </Section>
  );
}

/** Seconds as a church would say them. */
function hours(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds / 60));
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} hr ${whole % 60} min`;
}

function Row({
  label,
  value,
  quiet = false,
}: {
  label: string;
  value: string;
  quiet?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt
        className={`text-[12.5px] ${quiet ? "text-pulpitry-muted" : "text-pulpitry-text"}`}
      >
        {label}
      </dt>
      <dd className="text-[12.5px] tabular-nums text-pulpitry-text">{value}</dd>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-[12px] tracking-[0.12em] text-pulpitry-muted uppercase">
          {title}
        </h3>
        <p className="mt-0.5 text-[11.5px] text-pulpitry-muted">{note}</p>
      </div>
      {children}
    </section>
  );
}

export function SettingsDialog({
  settings,
  onClose,
  onSaved,
}: {
  settings: SettingsView;
  onClose: () => void;
  onSaved: (next: SettingsView) => void;
}) {
  const [region, setRegion] = useState(settings.azureRegion);
  const [language, setLanguage] = useState(settings.language);
  const [key, setKey] = useState("");

  const [assistEnabled, setAssistEnabled] = useState(settings.assistEnabled);
  const [assistEndpoint, setAssistEndpoint] = useState(settings.assistEndpoint);
  const [assistModel, setAssistModel] = useState(settings.assistModel);
  const [assistApiVersion, setAssistApiVersion] = useState(
    settings.assistApiVersion,
  );
  const [assistKey, setAssistKey] = useState("");

  const [mirrorEnabled, setMirrorEnabled] = useState(settings.mirrorEnabled);
  const [speed, setSpeed] = useState<string | null>(null);
  const [timing, setTiming] = useState(false);

  const [updateCheck, setUpdateCheck] = useState(settings.updateCheck);
  const [checkIn, setCheckIn] = useState(settings.checkIn);
  const [semanticEnabled, setSemanticEnabled] = useState(
    settings.semanticEnabled,
  );
  const [semanticThreshold, setSemanticThreshold] = useState(
    settings.semanticThreshold,
  );

  const [engine, setEngine] = useState(settings.speechEngine || "local");
  // Tracked rather than read straight from settings, because activating in this
  // dialog must make the option selectable without reopening it.
  const [hosted, setHosted] = useState(settings.hasHostedSubscription);
  /* Account first: it is where a church starts, and where the one thing that
     stops the software working -- an expired or unentered licence -- lives. */
  const [pane, setPane] = useState<PaneId>("account");
  const [model, setModel] = useState(settings.speechModel);
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  // The `.en` builds cannot transcribe anything but English. Falls back to the
  // file name so this is right before the model list has arrived.
  const englishOnlyModel =
    engine === "local" &&
    (models.find((entry) => entry.file === model)?.englishOnly ??
      model.includes(".en"));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only when the operator actually wants it: this reaches whisper.cpp's
  // repository, and doing it on every dialog open would be a round trip nobody
  // asked for.
  useEffect(() => {
    if (engine !== "local" || models.length > 0) return;
    let cancelled = false;
    setModelNote("Looking up the available models…");
    speechModels()
      .then((found) => {
        if (cancelled) return;
        setModels(found);
        setModelNote(
          found.length
            ? `One was chosen for this machine and downloaded; this is here to change it. Larger is more accurate and slower — if transcription starts arriving behind the speaker, come back and take the next one down. ${found.length} available.`
            : "No models could be listed. Check the connection, or use Azure for now.",
        );
      })
      .catch((err) => !cancelled && setModelNote(String(err)));
    return () => {
      cancelled = true;
    };
  }, [engine, models.length]);

  // The download runs in the Rust core and reports as it goes, so a 1.5 GB
  // model does not look like a frozen dialog.
  useEffect(() => {
    const unlisten = listen<ModelProgress>("speech-model-progress", (event) => {
      const p = event.payload;
      if (p.state === "downloading" && p.total) {
        setModelNote(
          `Downloading ${p.file} — ${Math.round((p.received! * 100) / p.total)}%`,
        );
        return;
      }
      setFetching(false);
      if (p.state === "ready") {
        setModelNote(`${p.file} is ready.`);
        setModel(p.file);
        // Re-listed so it shows as downloaded and the choice visibly took.
        speechModels()
          .then(setModels)
          .catch(() => {});
      } else {
        setModelNote(`Could not download ${p.file}. ${p.error ?? ""}`);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (key.trim()) await saveAzureKey(key.trim());
      if (assistKey.trim()) await saveAssistKey(assistKey.trim());

      const next = await saveSettings({
        azureRegion: region.trim(),
        language,
        inputDeviceId: settings.inputDeviceId,
        translation: settings.translation,
        assistEnabled,
        assistEndpoint: assistEndpoint.trim(),
        assistModel: assistModel.trim(),
        assistApiVersion: assistApiVersion.trim(),
        updateCheck,
        checkIn,
        semanticEnabled,
        semanticThreshold,
        mirrorEnabled,
        speechEngine: engine,
        speechModel: model,
        // Made once by the backend and never edited here; sending back what we
        // were given keeps this machine's identity to the subscription stable.
        hostedDeviceId: settings.hostedDeviceId,
        // Carried through untouched: the look is edited in the Themes tab, and
        // a stale copy held open in this dialog would undo it on save.
        projector: settings.projector,
      });

      setKey("");
      setAssistKey("");
      onSaved(next);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const forget = async (which: "speech" | "assist") => {
    setError(null);
    try {
      if (which === "speech") {
        await clearAzureKey();
        onSaved({ ...settings, hasAzureKey: false });
      } else {
        await clearAssistKey();
        onSaved({ ...settings, hasAssistKey: false });
      }
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <div
      data-dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        // Wider than it was, because a rail takes 164px and the pane beside it
        // still has to hold a sentence of consequence under every setting.
        className="flex max-h-full w-full max-w-[760px] flex-col rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl"
      >
        <header className="shrink-0 border-b border-pulpitry-line px-5 py-3.5">
          <h2 className="text-[15px] text-pulpitry-text">Settings</h2>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Rail active={pane} onChoose={setPane} />

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
            <Pane id="account" active={pane}>
              {/* Always mounted, so the engine picker knows whether a licence
                  is active even while somebody is looking at another pane. */}
              <Section
                title="Subscription"
                note="Hosted transcription and the assistant, metered against your plan. The applications work without one."
              >
                <HostedSubscription onActivationChange={setHosted} />
              </Section>
            </Pane>

            <Pane id="audio" active={pane}>
              <Section
                title="Transcription"
                note="Where the words come from. Verse detection is local either way and needs no network."
              >
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-pulpitry-muted">
                    Engine
                  </span>
                  <select
                    value={engine}
                    onChange={(event) => setEngine(event.target.value)}
                    className={FIELD}
                  >
                    {/* First, because it is the default and the one most churches
                    should stay on. A model for it has already been chosen and
                    fetched by the time anybody opens this. */}
                    <option value="local">
                      This machine — free, no account needed
                    </option>
                    {/* Always offered, including before activation: choosing it is
                    how somebody reaches the licence field below. */}
                    <option value="hosted">
                      Castavox subscription
                      {hosted ? "" : " — needs a licence key"}
                    </option>
                    <option value="azure">
                      Azure Speech — your own account
                    </option>
                  </select>
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    This machine transcribes a sentence once it ends, so a verse
                    arrives a second or two later — but it needs no account, no
                    key and no network, and it costs nothing per hour. The other
                    two stream: words appear as they are spoken and a verse can
                    be found mid-sentence. A Castavox subscription does that
                    without your church having to open an Azure account at all.
                  </span>
                </label>

                {/* Only what the chosen engine actually uses. An Azure key sitting
                under "This machine" reads as something that must be filled in,
                and the field that does matter is lost among three that do not. */}
                {/* The licence lives in Account now. Naming it here is the whole
                point: an engine that needs one, and a place to go and get it. */}
                {engine === "hosted" && !hosted ? (
                  <p className="text-[11.5px] leading-snug text-pulpitry-muted">
                    This engine needs a licence key.{" "}
                    <button
                      type="button"
                      onClick={() => setPane("account")}
                      className="text-pulpitry-gold underline-offset-2 hover:underline focus-visible:focus-ring"
                    >
                      Enter one in Account
                    </button>
                    .
                  </p>
                ) : null}

                {engine === "local" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-pulpitry-muted">
                      Model
                    </span>
                    <div className="flex gap-2">
                      <select
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        className={`min-w-0 flex-1 ${FIELD}`}
                      >
                        {model && !models.some((m) => m.file === model) ? (
                          /* Shown before the list arrives, so the box does not read
                         as unset when a choice is already stored. */
                          <option value={model}>{model}</option>
                        ) : null}
                        {models.length === 0 && !model ? (
                          <option value="">—</option>
                        ) : null}
                        {models.map((m) => (
                          <option key={m.file} value={m.file}>
                            {/* Size first: on the machine most churches own, that is
                            the number that decides. */}
                            {m.label} — {describeSize(m.bytes)} ·{" "}
                            {[
                              m.englishOnly ? "English only" : "any language",
                              m.quantised
                                ? "smaller, slightly less accurate"
                                : null,
                              m.installed ? "downloaded" : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!model || fetching}
                        onClick={() => {
                          setFetching(true);
                          setModelNote("Starting the download…");
                          void downloadSpeechModel(model).catch((err) => {
                            setFetching(false);
                            setModelNote(String(err));
                          });
                        }}
                        className="rounded border border-pulpitry-line px-3 py-2 text-[12.5px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
                      >
                        {fetching ? "Downloading…" : "Download"}
                      </button>
                      {/* Measured, because reasoning about the processor has been
                      wrong in both directions: a thin-and-light was handed a
                      model it could not carry, and a machine that decodes
                      twenty-five times faster than speech was told it might
                      struggle. Four seconds settles it, before a Sunday. */}
                      <button
                        type="button"
                        disabled={!model || timing}
                        onClick={() => {
                          setTiming(true);
                          setSpeed("Timing this machine…");
                          void measureSpeech()
                            .then((result) =>
                              setSpeed(
                                result.factor > 0
                                  ? `${result.detail} (${(1 / result.factor).toFixed(1)}x real time)`
                                  : result.detail,
                              ),
                            )
                            .catch((err) => setSpeed(describeError(err)))
                            .finally(() => setTiming(false));
                        }}
                        className="rounded border border-pulpitry-line px-3 py-2 text-[12.5px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
                      >
                        {timing ? "Timing…" : "Time it"}
                      </button>
                    </div>
                    {speed ? (
                      <p className="text-[11.5px] leading-snug text-pulpitry-muted">
                        {speed}
                      </p>
                    ) : null}
                    {modelNote ? (
                      <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                        {modelNote}
                      </span>
                    ) : null}
                  </label>
                ) : (
                  /* Azure and a subscription both stream through the Node bridge,
                 so both need a runtime. Only transcribing here does not. */
                  <NodeRuntimeNotice />
                )}

                {engine === "azure" ? (
                  <>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-pulpitry-muted">
                        Azure Speech key
                        {settings.hasAzureKey ? (
                          <span className="ml-2 text-pulpitry-teal">
                            stored in your keychain
                          </span>
                        ) : null}
                      </span>
                      <input
                        type="password"
                        value={key}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setKey(event.target.value)}
                        placeholder={
                          settings.hasAzureKey
                            ? "•••••••• (leave blank to keep)"
                            : "Paste your key"
                        }
                        className={FIELD}
                      />
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-pulpitry-muted">
                        Region
                      </span>
                      <input
                        list="pulpitry-azure-regions"
                        value={region}
                        spellCheck={false}
                        onChange={(event) => setRegion(event.target.value)}
                        placeholder="e.g. uksouth"
                        className={FIELD}
                      />
                      <datalist id="pulpitry-azure-regions">
                        {REGIONS.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </label>
                  </>
                ) : null}

                {/* Every engine uses it now, except an .en model, which cannot do
                anything but English -- told to decode Yoruba it produces
                English-shaped nonsense rather than Yoruba, so the choice is not
                offered where it would be a promise nothing can keep. */}
                {englishOnlyModel ? null : (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-pulpitry-muted">
                      Spoken language
                    </span>
                    <select
                      value={language}
                      onChange={(event) => setLanguage(event.target.value)}
                      className={FIELD}
                    >
                      {LANGUAGES.map((entry) => (
                        <option key={entry.code} value={entry.code}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    {/* Said at the moment of choosing rather than discovered during
                    a sermon, which is when the wrong engine announces itself. */}
                    {languageWarning(language, engine) ? (
                      <span className="mt-1.5 block text-[11.5px] leading-snug text-pulpitry-gold">
                        {languageWarning(language, engine)}
                      </span>
                    ) : null}
                  </label>
                )}

                {engine === "azure" && settings.hasAzureKey ? (
                  <button
                    type="button"
                    onClick={() => void forget("speech")}
                    className="self-start rounded px-1 py-0.5 text-[11.5px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                  >
                    Forget speech key
                  </button>
                ) : null}
              </Section>
            </Pane>

            <Pane id="scripture" active={pane}>
              <Section
                title="Paraphrase matching"
                note="Finds scripture the speaker renders in their own words, by meaning rather than wording. Runs entirely on your machine — no network, no cost. Preparing a translation takes a couple of minutes the first time."
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={semanticEnabled}
                    onChange={(event) =>
                      setSemanticEnabled(event.target.checked)
                    }
                    className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                  />
                  <span className="text-[13px] text-pulpitry-text">
                    Match paraphrased scripture locally
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="flex items-baseline justify-between text-[12px] text-pulpitry-muted">
                    <span>Minimum similarity</span>
                    <span className="tabular-nums text-pulpitry-text">
                      {Math.round(semanticThreshold * 100)}%
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0.3}
                    max={0.9}
                    step={0.01}
                    value={semanticThreshold}
                    disabled={!semanticEnabled}
                    onChange={(event) =>
                      setSemanticThreshold(Number(event.target.value))
                    }
                    className="accent-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
                  />
                  <span className="text-[11px] text-pulpitry-muted">
                    Lower surfaces more, including looser links. Higher stays
                    quiet unless the wording is close. Unrelated speech
                    typically scores below 30%.
                  </span>
                </label>
              </Section>
              <div className="border-t border-pulpitry-line" />
              {engine === "hosted" ? (
                <>
                  <div className="border-t border-pulpitry-line" />
                  <Section
                    title="Model assistance"
                    note="Included in your subscription. Suggests passages the speaker paraphrases rather than quotes, and writes the summary afterwards. The model proposes references only — every verse shown is read from your local library, so it cannot invent scripture."
                  >
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={assistEnabled}
                        onChange={(event) =>
                          setAssistEnabled(event.target.checked)
                        }
                        className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                      />
                      <span className="text-[13px] text-pulpitry-text">
                        Suggest paraphrased scripture
                      </span>
                    </label>
                  </Section>
                </>
              ) : (
                <>
                  <div className="border-t border-pulpitry-line" />

                  <Section
                    title="Model assistance"
                    note="Optional. Suggests passages the speaker paraphrases rather than quotes. The model proposes references only — every verse shown is read from your local library, so it cannot invent scripture."
                  >
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={assistEnabled}
                        onChange={(event) =>
                          setAssistEnabled(event.target.checked)
                        }
                        className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                      />
                      <span className="text-[13px] text-pulpitry-text">
                        Suggest paraphrased scripture using an Azure AI Foundry
                        model
                      </span>
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-pulpitry-muted">
                        Endpoint
                      </span>
                      <input
                        value={assistEndpoint}
                        spellCheck={false}
                        onChange={(event) =>
                          setAssistEndpoint(event.target.value)
                        }
                        placeholder="https://your-resource.services.ai.azure.com/models"
                        className={FIELD}
                      />
                    </label>

                    <div className="flex gap-3">
                      <label className="flex flex-[2] flex-col gap-1.5">
                        <span className="text-[12px] text-pulpitry-muted">
                          Model or deployment
                        </span>
                        <input
                          value={assistModel}
                          spellCheck={false}
                          onChange={(event) =>
                            setAssistModel(event.target.value)
                          }
                          placeholder="e.g. gpt-4o-mini"
                          className={FIELD}
                        />
                      </label>
                      <label className="flex flex-1 flex-col gap-1.5">
                        <span className="text-[12px] text-pulpitry-muted">
                          API version
                        </span>
                        <input
                          value={assistApiVersion}
                          spellCheck={false}
                          onChange={(event) =>
                            setAssistApiVersion(event.target.value)
                          }
                          className={FIELD}
                        />
                      </label>
                    </div>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-pulpitry-muted">
                        Model key
                        {settings.hasAssistKey ? (
                          <span className="ml-2 text-pulpitry-teal">
                            stored in your keychain
                          </span>
                        ) : null}
                      </span>
                      <input
                        type="password"
                        value={assistKey}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setAssistKey(event.target.value)}
                        placeholder={
                          settings.hasAssistKey
                            ? "•••••••• (leave blank to keep)"
                            : "Paste your key"
                        }
                        className={FIELD}
                      />
                    </label>

                    {settings.hasAssistKey ? (
                      <button
                        type="button"
                        onClick={() => void forget("assist")}
                        className="self-start rounded px-1 py-0.5 text-[11.5px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
                      >
                        Forget model key
                      </button>
                    ) : null}
                  </Section>
                </>
              )}
            </Pane>

            <Pane id="stage" active={pane}>
              <Section
                title="Mirror to Castavox"
                note="For a church running both, on two machines in the same building."
              >
                <MirrorPanel
                  enabled={mirrorEnabled}
                  onEnabledChange={setMirrorEnabled}
                />
              </Section>
              <div className="border-t border-pulpitry-line" />
              <Section
                title="Send the screen elsewhere"
                note="For a video team whose switcher is not Castavox, or who need the picture itself rather than the verse."
              >
                <NdiPanel />
              </Section>
            </Pane>

            <Pane id="usage" active={pane}>
              <Usage />
            </Pane>

            {/* Outside the panes: a save fails for the whole dialogue, and an
                error hidden behind the pane that caused it is an error nobody
                sees. */}
            {error ? (
              <p className="text-[12px] text-pulpitry-gold">{error}</p>
            ) : null}

            <Pane id="help" active={pane}>
              <Section
                title="New versions"
                note="Once a day, Pulpitry asks the public download page whether a newer version has been published, and says so quietly if one has. The request carries nothing at all — no identifier, no version, nothing about this machine — and it does not reach our servers: the releases are on GitHub, which already serves every download. Switch it off for a machine that should touch nothing."
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={updateCheck}
                    onChange={(event) => setUpdateCheck(event.target.checked)}
                    className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                  />
                  <span className="text-[13px] text-pulpitry-text">
                    Tell me when a new version is out
                  </span>
                </label>
              </Section>
              <div className="border-t border-pulpitry-line" />
              <Section
                title="Telling us this installation exists"
                note="Once a day, if you switch it on: a random identifier made on this machine, which application and version, your operating system, what kind of processor it has, and which transcription engine you chose. Your country is worked out from the connection and the address is discarded. Never your machine's name, never your address, and never a transcript, a verse or a filename — there is no field for any of those. It never delays anything, and if it cannot be sent nothing happens."
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checkIn}
                    onChange={(event) => setCheckIn(event.target.checked)}
                    className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                  />
                  <span className="text-[13px] text-pulpitry-text">
                    Send a daily check-in
                  </span>
                </label>
              </Section>
            </Pane>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-pulpitry-line px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3.5 py-1.5 text-[13px] text-pulpitry-text focus-visible:focus-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-pulpitry-gold px-3.5 py-1.5 text-[13px] text-pulpitry-ink disabled:opacity-50 focus-visible:focus-ring"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
