import { useState } from "react";

import type { Item, PlanEntry } from "../lib/catalog";
import type { Presentable } from "../lib/usePresentation";
import { EmptyState } from "./Panel";

const CHROME =
  "rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring";

const ACTION =
  "rounded border border-pulpitry-line px-1.5 py-0.5 text-[13px] leading-none text-pulpitry-muted transition-colors hover:border-pulpitry-muted hover:text-pulpitry-text disabled:opacity-30 focus-visible:focus-ring";

/** What a line points at, for the operator scanning the plan. */
function kindLabel(entry: PlanEntry): string {
  if (entry.body.kind === "scripture") return "Scripture";
  return entry.body.kind === "item" ? "Song" : "";
}

/**
 * The service plan.
 *
 * Two things separate this from a list of verses: it survives the app closing,
 * and it holds the parts of a service that never reach the screen. A running
 * order that could only contain projectable things would not be the order the
 * service actually follows.
 */
export function SchedulePanel({
  services,
  openId,
  name,
  entries,
  saving,
  onCreate,
  onOpen,
  onRename,
  onDelete,
  onAddNote,
  onRemoveAt,
  onMove,
  onRelabel,
  onStage,
}: {
  services: Item[];
  openId: number | null;
  name: string;
  entries: PlanEntry[];
  saving: boolean;
  onCreate: () => void;
  onOpen: (id: number) => void;
  onRename: (name: string) => void;
  onDelete: (id: number) => void;
  onAddNote: (label: string) => void;
  onRemoveAt: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onRelabel: (index: number, label: string) => void;
  onStage: (index: number) => Promise<Presentable | null>;
}) {
  // Where the operator is in the plan. Local because it means "what I last
  // put up from this list", which no other part of the app can know.
  const [active, setActive] = useState<number | null>(null);
  const [missing, setMissing] = useState<number[]>([]);

  // Headings structure the plan without being steps in it, so they take no
  // number and the ones either side of them stay consecutive.
  const numbers = entries.reduce<number[]>((running, entry, index) => {
    const previous = index === 0 ? 0 : running[index - 1]!;
    running.push(entry.body.kind === "note" ? previous : previous + 1);
    return running;
  }, []);

  const stage = async (index: number) => {
    setActive(index);
    const staged = await onStage(index);
    setMissing((current) =>
      staged
        ? current.filter((at) => at !== index)
        : current.includes(index)
          ? current
          : [...current, index],
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-pulpitry-line px-2.5 py-2">
        <div className="flex gap-1.5">
          <input
            value={name}
            placeholder="Untitled service"
            aria-label="Service name"
            onChange={(event) => onRename(event.target.value)}
            className={`min-w-0 flex-1 ${CHROME} placeholder:text-pulpitry-muted`}
          />
          {services.length > 1 ? (
            <select
              value={openId ?? ""}
              aria-label="Open a saved service"
              onChange={(event) => onOpen(Number(event.target.value))}
              className={`max-w-[7.5rem] ${CHROME}`}
            >
              {services.map((service) => (
                <option key={service.id} value={service.id ?? ""}>
                  {service.title}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <div className="mt-1.5 flex items-center gap-1.5">
          <button type="button" onClick={onCreate} className={ACTION}>
            New
          </button>
          <button type="button" onClick={() => onAddNote("Heading")} className={ACTION}>
            Add heading
          </button>
          <button
            type="button"
            onClick={() => openId !== null && onDelete(openId)}
            disabled={openId === null}
            className={ACTION}
          >
            Delete
          </button>
          {saving ? (
            <span className="ml-auto text-[11px] text-pulpitry-muted">Saving…</span>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1">
        {entries.length === 0 ? (
          <EmptyState>
            Stage something and press Add to build the running order. It is kept between
            sessions, so Sunday’s plan can be made on Saturday.
          </EmptyState>
        ) : (
          <ol className="flex flex-col">
            {entries.map((entry, index) => {
              const note = entry.body.kind === "note";
              const isActive = active === index;
              const lost = missing.includes(index);

              return (
                <li key={index} className="flex items-center gap-1">
                  {note ? (
                    // A heading structures the plan rather than being part of
                    // it, so it is editable in place and never stages.
                    <input
                      value={entry.label}
                      aria-label={`Heading ${index + 1}`}
                      onChange={(event) => onRelabel(index, event.target.value)}
                      className="min-w-0 flex-1 rounded bg-transparent px-2 py-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase outline-none focus-visible:focus-ring"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void stage(index)}
                      className={`flex min-w-0 flex-1 items-baseline gap-2 rounded px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                        isActive
                          ? "bg-pulpitry-teal-dim text-pulpitry-text"
                          : "text-pulpitry-text hover:bg-pulpitry-raised"
                      }`}
                    >
                      <span className="shrink-0 text-[11px] text-pulpitry-muted tabular-nums">
                        {numbers[index]}.
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{entry.label}</span>
                      <span className="shrink-0 text-[10px] tracking-wide text-pulpitry-muted uppercase">
                        {lost ? "missing" : kindLabel(entry)}
                      </span>
                    </button>
                  )}

                  <span className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      onClick={() => onMove(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${entry.label} up`}
                      className={ACTION}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(index, 1)}
                      disabled={index === entries.length - 1}
                      aria-label={`Move ${entry.label} down`}
                      className={ACTION}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveAt(index)}
                      aria-label={`Remove ${entry.label} from the service`}
                      className={ACTION}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
