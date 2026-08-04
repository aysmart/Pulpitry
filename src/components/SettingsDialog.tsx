import { useEffect, useState } from "react";

import {
  clearAssistKey,
  clearAzureKey,
  describeError,
  saveAssistKey,
  saveAzureKey,
  saveSettings,
  type SettingsView,
} from "../lib/api";

/** Azure Speech regions, by the identifier the SDK expects. */
const REGIONS = [
  "australiaeast", "brazilsouth", "canadacentral", "centralindia", "centralus",
  "eastasia", "eastus", "eastus2", "francecentral", "germanywestcentral",
  "japaneast", "koreacentral", "northeurope", "norwayeast", "southafricanorth",
  "southcentralus", "southeastasia", "swedencentral", "switzerlandnorth",
  "uaenorth", "uksouth", "westeurope", "westus", "westus2", "westus3",
];

const LANGUAGES = [
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "en-NG", label: "English (Nigeria)" },
  { code: "en-AU", label: "English (Australia)" },
  { code: "en-CA", label: "English (Canada)" },
  { code: "en-IN", label: "English (India)" },
  { code: "en-ZA", label: "English (South Africa)" },
  { code: "fr-FR", label: "French (France)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
];

const FIELD =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-2 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring";

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-[12px] tracking-[0.12em] text-pulpitry-muted uppercase">{title}</h3>
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
  const [assistApiVersion, setAssistApiVersion] = useState(settings.assistApiVersion);
  const [assistKey, setAssistKey] = useState("");

  const [semanticEnabled, setSemanticEnabled] = useState(settings.semanticEnabled);
  const [semanticThreshold, setSemanticThreshold] = useState(settings.semanticThreshold);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        semanticEnabled,
        semanticThreshold,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="flex max-h-full w-full max-w-[560px] flex-col rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl"
      >
        <header className="shrink-0 border-b border-pulpitry-line px-5 py-3.5">
          <h2 className="text-[15px] text-pulpitry-text">Settings</h2>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
          <Section
            title="Transcription"
            note="Live transcription uses Azure Speech. Verse detection runs locally and needs no network."
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-pulpitry-muted">
                Azure Speech key
                {settings.hasAzureKey ? (
                  <span className="ml-2 text-pulpitry-teal">stored in your keychain</span>
                ) : null}
              </span>
              <input
                type="password"
                value={key}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setKey(event.target.value)}
                placeholder={settings.hasAzureKey ? "•••••••• (leave blank to keep)" : "Paste your key"}
                className={FIELD}
              />
            </label>

            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-[12px] text-pulpitry-muted">Region</span>
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

              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-[12px] text-pulpitry-muted">Spoken language</span>
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
              </label>
            </div>

            {settings.hasAzureKey ? (
              <button
                type="button"
                onClick={() => void forget("speech")}
                className="self-start rounded px-1 py-0.5 text-[11.5px] text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
              >
                Forget speech key
              </button>
            ) : null}
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
                onChange={(event) => setSemanticEnabled(event.target.checked)}
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
                onChange={(event) => setSemanticThreshold(Number(event.target.value))}
                className="accent-pulpitry-gold disabled:opacity-40 focus-visible:focus-ring"
              />
              <span className="text-[11px] text-pulpitry-muted">
                Lower surfaces more, including looser links. Higher stays quiet unless the
                wording is close. Unrelated speech typically scores below 30%.
              </span>
            </label>
          </Section>

          <div className="border-t border-pulpitry-line" />

          <Section
            title="Model assistance"
            note="Optional. Suggests passages the speaker paraphrases rather than quotes. The model proposes references only — every verse shown is read from your local library, so it cannot invent scripture."
          >
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={assistEnabled}
                onChange={(event) => setAssistEnabled(event.target.checked)}
                className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
              />
              <span className="text-[13px] text-pulpitry-text">
                Suggest paraphrased scripture using an Azure AI Foundry model
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-pulpitry-muted">Endpoint</span>
              <input
                value={assistEndpoint}
                spellCheck={false}
                onChange={(event) => setAssistEndpoint(event.target.value)}
                placeholder="https://your-resource.services.ai.azure.com/models"
                className={FIELD}
              />
            </label>

            <div className="flex gap-3">
              <label className="flex flex-[2] flex-col gap-1.5">
                <span className="text-[12px] text-pulpitry-muted">Model or deployment</span>
                <input
                  value={assistModel}
                  spellCheck={false}
                  onChange={(event) => setAssistModel(event.target.value)}
                  placeholder="e.g. gpt-4o-mini"
                  className={FIELD}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1.5">
                <span className="text-[12px] text-pulpitry-muted">API version</span>
                <input
                  value={assistApiVersion}
                  spellCheck={false}
                  onChange={(event) => setAssistApiVersion(event.target.value)}
                  className={FIELD}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-pulpitry-muted">
                Model key
                {settings.hasAssistKey ? (
                  <span className="ml-2 text-pulpitry-teal">stored in your keychain</span>
                ) : null}
              </span>
              <input
                type="password"
                value={assistKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setAssistKey(event.target.value)}
                placeholder={settings.hasAssistKey ? "•••••••• (leave blank to keep)" : "Paste your key"}
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

          {error ? <p className="text-[12px] text-pulpitry-gold">{error}</p> : null}
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
