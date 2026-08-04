import type { AudioDevice, SpeechStatus } from "../lib/api";
import type { Display, ProjectorState } from "../lib/projector";
import { Logo } from "./Logo";

const STATE_LABEL: Record<SpeechStatus["state"], string> = {
  idle: "Not listening",
  starting: "Starting…",
  listening: "Live",
  reconnecting: "Reconnecting…",
  error: "Stopped",
};

export function TopBar({
  status,
  devices,
  selectedDeviceId,
  onSelectDevice,
  onToggleListening,
  onOpenSettings,
  busy,
  displays,
  projector,
  onToggleProjector,
  onRefreshDisplays,
}: {
  status: SpeechStatus;
  devices: AudioDevice[];
  selectedDeviceId: string | null;
  onSelectDevice: (id: string | null) => void;
  onToggleListening: () => void;
  onOpenSettings: () => void;
  busy: boolean;
  displays: Display[];
  projector: ProjectorState;
  onToggleProjector: (display?: number) => void;
  onRefreshDisplays: () => void;
}) {
  const live = status.state === "listening";
  const active = live || status.state === "starting" || status.state === "reconnecting";

  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b border-pulpitry-line bg-pulpitry-surface px-3">
      <div className="flex items-center gap-2 pr-1">
        <Logo className="h-6 w-6 text-pulpitry-gold" />
        <span className="text-[15px] tracking-tight text-pulpitry-text">pulpitry</span>
      </div>

      <div
        className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] tracking-[0.1em] uppercase ${
          live
            ? "border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
            : "border-pulpitry-line text-pulpitry-muted"
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            live ? "live-pulse bg-pulpitry-gold" : "bg-pulpitry-muted"
          }`}
          aria-hidden
        />
        {STATE_LABEL[status.state]}
      </div>

      <div className="flex-1" />

      <label className="flex items-center gap-2 text-[12px] text-pulpitry-muted">
        <span className="sr-only">Microphone</span>
        <select
          value={selectedDeviceId ?? ""}
          onChange={(event) => onSelectDevice(event.target.value || null)}
          className="max-w-[240px] truncate rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring"
        >
          <option value="">
            {(() => {
              const fallback = devices.find((device) => device.isDefault);
              return fallback ? `${fallback.name} (default)` : "System default";
            })()}
          </option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={onToggleListening}
        disabled={busy}
        className={`rounded px-3.5 py-1.5 text-[12px] transition-colors disabled:opacity-50 focus-visible:focus-ring ${
          active
            ? "bg-pulpitry-gold text-pulpitry-ink hover:bg-pulpitry-gold/90"
            : "border border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-gold-dim hover:text-pulpitry-gold"
        }`}
      >
        {active ? "Stop listening" : "Start listening"}
      </button>

      {/* Which screen the congregation sees. Only worth choosing when there
          is more than one. */}
      {displays.length > 1 ? (
        <select
          value={projector.display ?? ""}
          aria-label="Projector display"
          onFocus={onRefreshDisplays}
          onChange={(event) => onToggleProjector(Number(event.target.value))}
          className="max-w-[170px] truncate rounded border border-pulpitry-line bg-pulpitry-raised px-2 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring"
        >
          <option value="" disabled>
            Choose a display
          </option>
          {displays.map((display) => (
            <option key={display.index} value={display.index}>
              {display.name} ({display.width}×{display.height})
              {display.isPrimary ? " — main" : ""}
            </option>
          ))}
        </select>
      ) : null}

      <button
        type="button"
        onClick={() => onToggleProjector()}
        onMouseEnter={onRefreshDisplays}
        title={
          projector.open
            ? "Close the congregation display"
            : "Open the congregation display on a second screen"
        }
        className={`rounded px-3 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
          projector.open
            ? "border border-pulpitry-gold-dim bg-pulpitry-gold/10 text-pulpitry-gold"
            : "border border-pulpitry-line bg-pulpitry-raised text-pulpitry-text hover:border-pulpitry-muted"
        }`}
      >
        {projector.open ? "Projector on" : "Projector"}
      </button>

      {displays.length === 1 && !projector.open ? (
        <span
          title="Only one display was found, so the projector will cover this window. Press Escape on it to close."
          className="text-[11px] text-pulpitry-muted"
        >
          1 screen
        </span>
      ) : null}

      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings"
        className="rounded border border-pulpitry-line bg-pulpitry-raised p-1.5 text-pulpitry-muted transition-colors hover:text-pulpitry-text focus-visible:focus-ring"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="3.2" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
          />
        </svg>
      </button>
    </header>
  );
}
