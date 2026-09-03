import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { MirrorPanel } from "./MirrorPanel";
import { NdiPanel } from "./NdiPanel";
import { HostedSubscription } from "./HostedSubscription";
import { NodeRuntimeNotice } from "./NodeRuntimeNotice";
import { Feedback } from "./Feedback";
import { TranslationLibrary } from "./TranslationLibrary";

import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";

import {
  bibleAttributions,
  libraryStatus,
  onLibraryStatus,
  type LibraryStatus,
  type Translation,
} from "../lib/bible";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  clearAssistKey,
  describeError,
  exportLog,
  getSettings,
  hostedStatus,
  madeHere,
  listAudioInputs,
  measureSpeech,
  saveAssistKey,
  saveSettings,
  speechModels,
  downloadSpeechModel,
  type AudioDevice,
  type HostedView,
  type Tally,
  type ModelProgress,
  type SettingsView,
  type SpeechModel,
} from "../lib/api";

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

/**
 * The action an operator wrote, as the Rust side names it.
 *
 * Deliberately a short list. A custom phrase means one of the things the
 * application already does; the value is "shema" meaning next verse to one
 * church, not a scripting language.
 */
function actionFor(said: string): string | null {
  const want = said.trim().toLowerCase();
  if (want.startsWith("prev") || want.startsWith("back"))
    return "previousVerse";
  if (want.startsWith("next") || want.startsWith("forward")) return "nextVerse";
  if (want.startsWith("clear") || want.startsWith("blank")) return "clear";
  return null;
}

/** The same in reverse, for showing back what was saved. */
const WORDS_FOR: Record<string, string> = {
  previousVerse: "previous verse",
  nextVerse: "next verse",
  clear: "clear",
};

/**
 * One phrase per line, "what I say = what it does".
 *
 * A line whose action is not one we have is dropped rather than refused. A
 * dialog that will not accept a change because of a typo in an optional field,
 * ten minutes before a service, when the operator came here to alter something
 * else, is a worse failure than a phrase that quietly does not work.
 */
function parsePhrases(
  text: string,
): { said: string; does: { action: string } }[] {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      if (at <= 0) return null;
      const said = line.slice(0, at).trim();
      const action = actionFor(line.slice(at + 1));
      return said && action ? { said, does: { action } } : null;
    })
    .filter(
      (phrase): phrase is { said: string; does: { action: string } } =>
        phrase !== null,
    );
}

/**
 * Where a church's own model lives, and how it expects to be asked.
 *
 * A list rather than three empty boxes and a documentation search. The endpoint
 * is filled in; the model name is not, because a list of model names is wrong
 * within a month and wrong in the way that stops somebody using one that
 * exists.
 *
 * Most of these share one shape, because most of the industry copied OpenAI's.
 */
const ASSIST_PRESETS: {
  id: string;
  label: string;
  endpoint: string;
  shape: string;
  model: string;
}[] = [
  {
    id: "ollama",
    label: "On this machine — Ollama",
    endpoint: "http://localhost:11434/v1",
    shape: "openAi",
    model: "llama3.1",
  },
  {
    id: "lmstudio",
    label: "On this machine — LM Studio",
    endpoint: "http://localhost:1234/v1",
    shape: "openAi",
    model: "",
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    shape: "openAi",
    model: "gpt-4o-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com",
    shape: "anthropic",
    model: "claude-sonnet-4-5",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    shape: "openAi",
    model: "gemini-2.0-flash",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    shape: "openAi",
    model: "deepseek-chat",
  },
  {
    id: "grok",
    label: "Grok (xAI)",
    endpoint: "https://api.x.ai/v1",
    shape: "openAi",
    model: "grok-2-latest",
  },
  {
    id: "mistral",
    label: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    shape: "openAi",
    model: "mistral-large-latest",
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    shape: "openAi",
    model: "llama-3.3-70b-versatile",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    shape: "openAi",
    model: "",
  },
  {
    id: "azure",
    label: "Azure OpenAI or AI Foundry",
    endpoint: "",
    shape: "azure",
    model: "",
  },
  {
    id: "other",
    label: "Something else",
    endpoint: "",
    shape: "openAi",
    model: "",
  },
];

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
  {
    id: "feedback",
    name: "Feedback",
    note: "Something wrong, or something missing.",
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
  const [made, setMade] = useState<Tally | null>(null);

  useEffect(() => {
    let live = true;
    hostedStatus()
      .then((next) => live && setState(next))
      .catch(() => live && setState(null));
    madeHere()
      .then((next) => live && setMade(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const plan = state?.entitlement;

  /*
   * Shown above the plan, and shown without one.
   *
   * Making a summary is not metered -- the service is unlimited -- so this
   * belongs to the machine rather than to a subscription, and a church with no
   * plan at all should still be able to see what it has done.
   */
  const madeRows = made ? (
    <Section
      title="Made on this machine"
      note="Everything this machine has written, since it was installed."
    >
      <dl className="flex flex-col divide-y divide-pulpitry-line">
        <Row label="Summaries" value={made.summaries.toLocaleString()} />
        <Row label="Slide sets" value={made.slides.toLocaleString()} />
      </dl>
    </Section>
  ) : null;

  if (!state?.activated || !plan) {
    return (
      <>
        {madeRows}
        <Section
          title="Hours"
          note="Nothing is metered without a subscription. Transcribing on this machine is unlimited and always has been."
        >
          <p className="text-[12.5px] leading-relaxed text-pulpitry-muted">
            There is no plan on this machine, so there are no hours to count.
          </p>
        </Section>
      </>
    );
  }

  return (
    <>
      {madeRows}
      <Section
        title="This period"
        note="Hours are pooled across the applications and the machines on your plan."
      >
        <dl className="flex flex-col divide-y divide-pulpitry-line">
          <Row label="Transcription left" value={plan.speechRemaining} />
          {/* By application, because a pooled figure hides which of the two spent
            it -- and a church running both has no other way to find out. */}
          {Object.entries(plan.byApp).map(
            ([app, seconds]: [string, number]) => (
              <Row
                key={app}
                label={
                  app === "castavox" ? "Used by Castavox" : "Used by Pulpitry"
                }
                value={hours(seconds)}
                quiet
              />
            ),
          )}
          <Row
            label="Period ends"
            value={new Date(plan.periodEndsAt).toLocaleDateString()}
          />
        </dl>
      </Section>
    </>
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

/**
 * One setting with two states, shown rather than hidden behind a dropdown.
 *
 * A dropdown asks somebody to open it to find out what it is set to. For two
 * options that is a worse trade than the space it saves, and for the two here
 * -- whether the screen moves on its own -- it is the answer an operator most
 * wants at a glance while a service is starting.
 *
 * The chosen side carries the raised surface rather than the accent. The accent
 * is what this product uses for *live*, and a settings control wearing it reads
 * as something currently happening.
 */
function Switch<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <div
      role="radiogroup"
      className="flex w-fit gap-0.5 rounded border border-pulpitry-line bg-pulpitry-ink p-0.5"
    >
      {options.map(([id, label]) => {
        const chosen = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={chosen}
            onClick={() => onChange(id)}
            className={`rounded px-3 py-1 text-[12.5px] transition-colors focus-visible:focus-ring ${
              chosen
                ? "bg-pulpitry-raised text-pulpitry-text"
                : "text-pulpitry-muted hover:text-pulpitry-text"
            }`}
          >
            {label}
          </button>
        );
      })}
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
  const [language, setLanguage] = useState(settings.language);

  const [assistEnabled, setAssistEnabled] = useState(settings.assistEnabled);
  const [assistEndpoint, setAssistEndpoint] = useState(settings.assistEndpoint);
  const [assistModel, setAssistModel] = useState(settings.assistModel);
  const [assistApiVersion, setAssistApiVersion] = useState(
    settings.assistApiVersion,
  );
  const [assistShape, setAssistShape] = useState(settings.assistShape);
  /* Which row of the list the stored endpoint came from, so reopening shows
     what was chosen rather than resetting to the top. */
  const [assistPreset, setAssistPreset] = useState(
    () =>
      ASSIST_PRESETS.find(
        (preset) =>
          preset.endpoint !== "" && preset.endpoint === settings.assistEndpoint,
      )?.id ?? (settings.assistShape === "azure" ? "azure" : "other"),
  );
  const [assistKey, setAssistKey] = useState("");

  const [mirrorEnabled, setMirrorEnabled] = useState(settings.mirrorEnabled);
  const [speed, setSpeed] = useState<string | null>(null);
  const [timing, setTiming] = useState(false);

  const [updateCheck, setUpdateCheck] = useState(settings.updateCheck);
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

  /* Owned here now. The microphone and the translation were chosen in the main
     window and nowhere else, which is fine while somebody is looking at the
     main window and wrong when they have come to Settings to set the thing up
     before a service. Both write the same stored setting rather than a copy. */
  const [device, setDevice] = useState<string | null>(settings.inputDeviceId);
  const [translation, setTranslation] = useState(settings.translation);
  const [verseDisplay, setVerseDisplay] = useState(settings.verseDisplay);
  const [voiceCommands, setVoiceCommands] = useState(settings.voiceCommands);
  const [wakeWord, setWakeWord] = useState(settings.wakeWord);
  /* Edited as text, one phrase per line: "what I say = what it does". */
  const [voicePhrases, setVoicePhrases] = useState(() =>
    settings.voicePhrases
      .map((phrase) => `${phrase.said} = ${WORDS_FOR[phrase.does.action]}`)
      .join("\n"),
  );
  const [translations, setTranslations] = useState<Translation[]>([]);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [logNote, setLogNote] = useState<string | null>(null);
  /* Who the text licences oblige us to name. Read from what is installed, so
     it follows a translation a church downloaded or removed. */
  const [credits, setCredits] = useState<string[]>([]);

  const saveLog = async () => {
    setLogNote(null);
    try {
      const path = await save({
        title: "Save the log",
        defaultPath: "pulpitry-log.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      // Cancelling is not a failure and needs no message.
      if (!path) return;
      setLogNote(`Saved to ${await exportLog(path)}`);
    } catch (err) {
      setLogNote(describeError(err));
    }
  };

  /* The library announces itself when it changes, and the primary-translation
     list is the same set the library screen edits. Listening beats being told
     by the screen below: a download begun here and finished a minute later,
     or one removed from the other window, has to land in this list too. */
  useEffect(() => {
    let live = true;
    const apply = (status: LibraryStatus) => {
      if (!live) return;
      setTranslations(status.translations);
      // Removing the translation in use leaves the setting naming one that is
      // no longer on the machine, and detection would then search a
      // translation with no verses in it and quietly find nothing. Move to
      // whatever remains first; the auto-save writes it like any other change.
      setTranslation((current) =>
        status.translations.some((entry) => entry.id === current)
          ? current
          : (status.translations[0]?.id ?? current),
      );
    };

    let unlisten: UnlistenFn | undefined;
    void onLibraryStatus(apply).then((stop) => {
      if (live) unlisten = stop;
      else stop();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let live = true;
    void libraryStatus()
      .then((status) => live && setTranslations(status.translations))
      .catch(() => undefined);
    void listAudioInputs()
      .then((found) => live && setDevices(found))
      .catch(() => undefined);
    void bibleAttributions()
      .then((lines) => live && setCredits(lines))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
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
  const [savedAt, setSavedAt] = useState<number | null>(null);
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

  /**
   * Writes the settings. Called by the watcher below, not by a button.
   *
   * Secrets are not written here. A key is saved when its field loses focus,
   * because a debounce fires mid-typing and would store half an Azure key --
   * and a half key is not a harmless intermediate state, it is a configuration
   * that fails with an authentication error nobody can explain.
   */
  const persist = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await saveSettings({
        language,
        inputDeviceId: device,
        translation,
        verseDisplay,
        voiceCommands,
        wakeWord: wakeWord.trim(),
        voicePhrases: parsePhrases(voicePhrases),
        assistEnabled,
        assistEndpoint: assistEndpoint.trim(),
        assistModel: assistModel.trim(),
        assistApiVersion: assistApiVersion.trim(),
        assistShape,
        updateCheck,
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

      onSaved(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  /*
   * Saved as it is changed, rather than at a button.
   *
   * A settings dialogue with Save and Cancel asks somebody to remember they
   * pressed a switch, and punishes them for closing the window the way every
   * other window closes. Nothing here is a transaction: each of these is one
   * value the application reads next time it needs it.
   *
   * Debounced, because a text field would otherwise write on every keystroke.
   * The first run is skipped -- an effect that fires on mount would save the
   * settings the moment the dialogue opened, which turns opening it to look at
   * something into changing the file.
   */
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void persist(), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    language,
    device,
    translation,
    verseDisplay,
    voiceCommands,
    wakeWord,
    voicePhrases,
    assistEnabled,
    assistEndpoint,
    assistShape,
    assistModel,
    assistApiVersion,
    updateCheck,
    semanticEnabled,
    semanticThreshold,
    mirrorEnabled,
    engine,
    model,
  ]);

  /**
   * A key, written when its field is done rather than as it is typed.
   *
   * One key now. There were two while a church could bring its own Azure
   * Speech account; the assistant's is the only one left.
   */
  const keepKey = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await saveAssistKey(trimmed);
      setAssistKey("");
      onSaved({ ...settings, hasAssistKey: true });
      setSavedAt(Date.now());
    } catch (err) {
      setError(describeError(err));
    }
  };

  const forget = async () => {
    setError(null);
    try {
      await clearAssistKey();
      onSaved({ ...settings, hasAssistKey: false });
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
      <div
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
                <HostedSubscription
                  onActivationChange={(activated) => {
                    setHosted(activated);
                    /*
                     * Re-read what the window knows, not just what this dialog
                     * knows.
                     *
                     * Activating writes a device token to the credential store
                     * and changes no stored setting, so nothing else here had
                     * any reason to look again -- and the main window decides
                     * whether Start Listening can work from
                     * `hasHostedSubscription`, which is read from that store.
                     *
                     * Without this, a church that has just pasted a valid
                     * licence presses Start Listening and is sent back to this
                     * page, over and over, until they happen to change the
                     * engine and back -- which saves settings, and a save is
                     * the only thing that was refreshing this.
                     */
                    void getSettings()
                      .then(onSaved)
                      .catch(() => undefined);
                  }}
                />
                {/* Named rather than assumed. A church without a plan has no
                    way from here to the thing that sells one, and "contact us"
                    is not a price. */}
                <p className="text-[11.5px] leading-snug text-pulpitry-muted">
                  {hosted
                    ? "Changing plan, or adding hours: "
                    : "Plans and prices: "}
                  <button
                    type="button"
                    onClick={() => void openUrl("https://castavox.com/pricing")}
                    className="text-pulpitry-gold underline-offset-2 hover:underline focus-visible:focus-ring"
                  >
                    castavox.com/pricing
                  </button>
                </p>
              </Section>
            </Pane>

            <Pane id="audio" active={pane}>
              <Section
                title="Microphone"
                note="Which input the words are heard on. The engine below decides what happens to them."
              >
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-pulpitry-muted">Input</span>
                  <select
                    value={device ?? ""}
                    onChange={(event) => setDevice(event.target.value || null)}
                    className={FIELD}
                  >
                    <option value="">System default</option>
                    {devices.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    {devices.length === 1
                      ? "One input on this machine."
                      : `${devices.length} inputs on this machine.`}{" "}
                    A desk feed heard through a laptop microphone is the
                    commonest reason detection misses everything.
                  </span>
                </label>
              </Section>

              <div className="border-t border-pulpitry-line" />

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
                  </select>
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    This machine transcribes a sentence once it ends, so a verse
                    arrives a second or two later — but it needs no account, no
                    key and no network, and it costs nothing per hour. A
                    subscription streams: words appear as they are spoken and a
                    verse can be found mid-sentence. It does that without your
                    church having to open an Azure account at all.
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
              </Section>

              <div className="border-t border-pulpitry-line" />

              <Section
                title="Speaking to Pulpitry"
                note="Needs transcription running. On this machine a sentence is transcribed once you stop speaking, so an instruction lands a beat late; on a subscription or Azure it lands as you say it."
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={voiceCommands}
                    onChange={(event) => setVoiceCommands(event.target.checked)}
                    className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
                  />
                  <span className="text-[13px] text-pulpitry-text">
                    Act on what I say
                  </span>
                </label>

                {/*
                  Said plainly because the failure it guards against happens in
                  front of a congregation: an instruction has to be the whole of
                  what was said, so a reading that mentions the next verse
                  leaves the screen alone.
                */}
                <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                  Say what you want on its own &mdash; &ldquo;next verse&rdquo;,
                  &ldquo;previous verse&rdquo;, &ldquo;clear the screen&rdquo;,
                  or the name of a translation: &ldquo;give me the King
                  James&rdquo;. It has to be the whole thing you say; the same
                  words inside a sentence are left alone. Only the last breath
                  or two counts.
                </span>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-pulpitry-muted">
                    Wake word
                  </span>
                  <input
                    value={wakeWord}
                    onChange={(event) => setWakeWord(event.target.value)}
                    placeholder="Optional"
                    className={FIELD}
                  />
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    A second way in rather than a requirement. With one set,
                    anything you say after it counts &mdash; worth having for a
                    phrase you expect to hear from the pulpit.
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-pulpitry-muted">
                    Your own words
                  </span>
                  <textarea
                    value={voicePhrases}
                    onChange={(event) => setVoicePhrases(event.target.value)}
                    rows={4}
                    placeholder={
                      "shema = next verse\nback = previous verse\nrest = clear"
                    }
                    className={`${FIELD} font-mono`}
                  />
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    One per line: what you say, then what it does. A church says
                    things its own way, and the list above is ours rather than
                    yours.
                  </span>
                </label>
              </Section>
            </Pane>

            <Pane id="scripture" active={pane}>
              <Section
                title="Verses"
                note="What happens when the sermon reaches a passage."
              >
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-pulpitry-muted">
                    Primary translation
                  </span>
                  <select
                    value={translation}
                    onChange={(event) => setTranslation(event.target.value)}
                    className={FIELD}
                  >
                    {translations.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id} · {entry.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    What detection searches, and what a verse is staged in
                    unless you pick another in the moment.
                  </span>
                </label>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-pulpitry-muted">
                    When a verse is detected
                  </span>
                  {/* Two states, so a switch: a dropdown asks somebody to open
                      it to find out what it is set to, and this is the setting
                      an operator most wants to see the answer to at a glance
                      while a service is starting. */}
                  <Switch
                    value={verseDisplay}
                    onChange={setVerseDisplay}
                    options={[
                      ["manual", "Manual"],
                      ["auto", "Auto"],
                    ]}
                  />
                  {/*
                    Only the announced kind, and the distinction is the whole
                    setting. A speaker naming their passage has inferred
                    nothing; a text match can be them quoting something else in
                    passing, and a paraphrase match is weaker still.
                  */}
                  <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                    On auto, a passage the speaker names out loud — &ldquo;turn
                    with me to John 3&rdquo; — goes to the screen by itself.
                    Verses merely heard in what was said, and passages the model
                    thinks were paraphrased, always wait in the list: click to
                    preview one, double-click to send it.
                  </span>
                </div>
              </Section>

              <div className="border-t border-pulpitry-line" />

              <Section
                title="Library"
                note="Which translations this machine holds. Downloading one adds it everywhere the application reads scripture; removing one returns the space."
              >
                <TranslationLibrary />
              </Section>

              <div className="border-t border-pulpitry-line" />

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
                        Suggest paraphrased scripture using a model of your own
                      </span>
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-pulpitry-muted">
                        Where the model is
                      </span>
                      <select
                        value={assistPreset}
                        onChange={(event) => {
                          const chosen = ASSIST_PRESETS.find(
                            (preset) => preset.id === event.target.value,
                          );
                          if (!chosen) return;
                          setAssistPreset(chosen.id);
                          setAssistShape(chosen.shape);
                          // Filled in, not forced: a church with its own
                          // gateway can still edit the address afterwards.
                          if (chosen.endpoint)
                            setAssistEndpoint(chosen.endpoint);
                          if (chosen.model && !assistModel.trim())
                            setAssistModel(chosen.model);
                        }}
                        className={FIELD}
                      >
                        {ASSIST_PRESETS.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                      {/* The one place plain http is allowed, and worth saying
                          so where somebody is choosing it. */}
                      <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                        A model on this machine costs nothing per request and
                        nothing leaves the building. One at a provider is faster
                        and better at long services, and you pay them directly —
                        we never see the key or the bill.
                      </span>
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-pulpitry-muted">
                        Address
                      </span>
                      <input
                        value={assistEndpoint}
                        spellCheck={false}
                        onChange={(event) =>
                          setAssistEndpoint(event.target.value)
                        }
                        placeholder="https://…"
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
                      {/* Azure's alone. The others either ignore it or answer
                          a 404 when it is appended, so asking everybody for one
                          would be asking most churches for a wrong answer. */}
                      {assistShape === "azure" ? (
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
                      ) : null}
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
                        onBlur={(event) => void keepKey(event.target.value)}
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
                        onClick={() => void forget()}
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

            <Pane id="feedback" active={pane}>
              <Section
                title="Tell us"
                note="Three questions, because they are the four exchanges a support thread otherwise spends establishing them — asked once, while you still remember."
              >
                <Feedback />
              </Section>
            </Pane>

            <Pane id="help" active={pane}>
              <Section
                title="When something goes wrong"
                note="The log records what the application did, not what was said. No transcript, no verse, no audio."
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void saveLog()}
                    className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text focus-visible:focus-ring"
                  >
                    Save the log&hellip;
                  </button>
                  {logNote ? (
                    <span className="text-[11.5px] text-pulpitry-muted">
                      {logNote}
                    </span>
                  ) : null}
                </div>
                {/* Both files, because the failure worth reading is often the
                    one that made them restart the application. */}
                <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                  Saves this run and the one before it, somewhere you can attach
                  them to an email. The file lives in a folder a file chooser
                  cannot reach, which is where most support threads stop.
                </span>
              </Section>

              <div className="border-t border-pulpitry-line" />

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
              {/*
                No switch, and the text has to be straight about that.

                A screen that lists what is sent and offers no way to decline is
                doing the one thing it can still honestly do: telling somebody
                exactly what leaves their machine. Wording it as though it were
                a courtesy would be worse than saying nothing.
              */}
              <Section
                title="Telling us this installation exists"
                note="Once a day, every installation sends: a random identifier made on this machine, which application and version, your operating system, what kind of processor it has, which transcription engine you chose, and how many summaries and slide sets this installation has made. Two counts, and nothing about what is in any of them. Your country is worked out from the connection and the address is discarded. Never your machine's name, never your address, and never a transcript, a verse or a filename — there is no field for any of those. It never delays anything, and if it cannot be sent nothing happens."
              >
                <span className="text-[11.5px] leading-snug text-pulpitry-muted">
                  This one cannot be turned off. It is how we know how many
                  churches run this, on what, and on which release — questions
                  we were otherwise guessing at. If you would rather not be
                  counted, write to support@castavox.com and we will delete what
                  is held against your installation.
                </span>
              </Section>

              {/*
                Not a credits screen.

                Several of the translations are CC BY-SA. That licence permits
                the commercial use we make of the text and asks to be told who
                wrote it in return, so this is how we meet the terms rather
                than a courtesy — which is why it sits in Help beside the other
                obligations and not behind an About box somebody may never
                open. Hidden when there is nothing to say: a church that
                removed every one of those texts owes nobody anything.
              */}
              {credits.length > 0 && (
                <>
                  <div className="border-t border-pulpitry-line" />
                  <Section
                    title="Text licences"
                    note="Some of the translations installed here are used under a licence that asks us to name their source."
                  >
                    <div className="flex flex-col gap-1">
                      {credits.map((line) => (
                        <span
                          key={line}
                          className="text-[12px] leading-snug text-pulpitry-text"
                        >
                          {line}
                        </span>
                      ))}
                    </div>
                  </Section>
                </>
              )}
            </Pane>
          </div>
        </div>

        {/*
          What happened, not what to press.
          
          Nothing here is a transaction, so there is nothing to confirm or
          abandon -- and a Cancel button that cannot undo what it implies it
          undoes is worse than no button. What an operator needs instead is to
          know the change took, which is the one thing Save used to tell them
          as a side effect.
        */}
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-pulpitry-line px-5 py-3.5">
          <span className="text-[11.5px] text-pulpitry-muted">
            {saving
              ? "Saving…"
              : savedAt
                ? "Saved."
                : "Changes are kept as you make them."}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3.5 py-1.5 text-[13px] text-pulpitry-text focus-visible:focus-ring"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
