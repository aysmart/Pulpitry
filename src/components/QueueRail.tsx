import type { PlanEntry } from "../lib/catalog";
import { EmptyState } from "./Panel";

/**
 * What this service is going to do, in order, always visible.
 *
 * The plan already existed — it is the service saved in the library, and it
 * outlives the session — but it lived behind a tab, which meant an operator
 * could only see what was coming by leaving the thing they were doing. That is
 * the wrong trade during a service: the next item is the one question a plan is
 * kept to answer.
 *
 * # Deliberately not a second stage
 *
 * Clicking an entry stages it, exactly as clicking it in the schedule tab does.
 * It does not go live, and there is no control here that puts anything on a
 * wall — the fixed strip above owns that, and two paths to going live is one
 * more than anybody should have to think about mid-sermon.
 *
 * # Why it does not scroll on its own
 *
 * A service plan is a dozen entries, not a hundred. Giving it its own scrollbar
 * inside a rail that already scrolls produces two bars a hand's width apart,
 * and the operator has to guess which one moves the thing they are looking at.
 */
export function QueueRail({
  entries,
  name,
  onStage,
  onRemove,
  activeLabel,
}: {
  entries: PlanEntry[];
  /** The service being run, so the rail says which plan this is. */
  name: string;
  /** Stages the entry. `andShow` sends it in the same gesture. */
  onStage: (index: number, andShow?: boolean) => void;
  /** Takes one entry out of the running order without showing it. */
  onRemove: (index: number) => void;
  /** What is on screen, so the entry matching it can be marked. */
  activeLabel: string | null;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState>
        {name
          ? `“${name}” has nothing in it yet. Stage something and press Add to build the running order.`
          : "No service is open. Open or start one under Schedule to plan a running order."}
      </EmptyState>
    );
  }

  return (
    <ol className="flex flex-col gap-1 p-1">
      {entries.map((entry, index) => {
        /*
         * Matched on the label rather than an id, because a plan entry holds a
         * reference and what is live holds text. It is a weak match and that is
         * acceptable: being wrong marks the wrong line in a list of twelve,
         * which the operator can see is wrong. Nothing acts on it.
         */
        const isLive = activeLabel !== null && entry.label === activeLabel;

        return (
          /*
           * The row and its remove control, side by side rather than nested.
           *
           * A button inside a button is invalid HTML whose inner clicks
           * browsers deliver inconsistently -- the Original panel lost a whole
           * feature to exactly that, so the two controls are siblings and the
           * staging one takes the remaining width.
           */
          <li
            key={`${entry.label}-${index}`}
            className="group flex items-stretch gap-1"
          >
            <button
              type="button"
              onClick={() => onStage(index)}
              onDoubleClick={() => onStage(index, true)}
              title="Click to stage, double-click to put it on screen"
              className={`flex min-w-0 flex-1 items-baseline gap-2 rounded border px-2 py-1.5 text-left transition-colors focus-visible:focus-ring ${
                isLive
                  ? "border-pulpitry-gold-dim bg-pulpitry-gold/10"
                  : "border-transparent hover:border-pulpitry-line hover:bg-pulpitry-raised"
              }`}
            >
              {/* The position, because a running order is a sequence and
                  "we are on four" is how a team talks about it. */}
              <span className="w-4 shrink-0 text-[11px] text-pulpitry-muted tabular-nums">
                {index + 1}
              </span>
              <span
                className={`line-clamp-2 text-[12.5px] leading-snug ${
                  isLive ? "text-pulpitry-gold" : "text-pulpitry-text"
                }`}
              >
                {entry.label}
              </span>
            </button>

            {/* Shown on hover and on keyboard focus. A running order is read
                far more often than it is edited, and a column of crosses down
                the side of it is noise during the one hour it matters. */}
            <button
              type="button"
              onClick={() => onRemove(index)}
              title="Take this out of the running order"
              aria-label={`Remove ${entry.label} from the running order`}
              className="shrink-0 rounded px-1.5 text-[13px] leading-none text-pulpitry-muted opacity-0 transition-opacity hover:bg-pulpitry-raised hover:text-pulpitry-text focus-visible:opacity-100 focus-visible:focus-ring group-hover:opacity-100"
            >
              &times;
            </button>
          </li>
        );
      })}
    </ol>
  );
}
