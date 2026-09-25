import { useEffect, useRef, useState } from "react";

export interface Choice {
  value: string;
  label: string;
  /** Said quietly beside the name: a chapter count, a translation's year. */
  hint?: string;
}

/**
 * Whether a choice answers to what has been typed.
 *
 * Any part of the name, not only its start: an operator looking for
 * 1 Corinthians types "cor" far more often than "1 c", and a picker that only
 * matched the beginning made them scroll for the one book they knew the name
 * of. Punctuation and spacing are ignored, so "1co", "1 co" and "i cor" all
 * arrive at the same place.
 */
function matches(choice: Choice, typed: string): boolean {
  const plain = (text: string) =>
    text
      .toLowerCase()
      .split("")
      .filter((c) => /[a-z0-9]/.test(c))
      .join("");
  const needle = plain(typed);
  return needle.length === 0 || plain(choice.label).includes(needle);
}

/**
 * A list you can type at.
 *
 * # Why not a `select`
 *
 * A dropdown of sixty-six books is a scroll, and typing into one only jumps by
 * first letter — so reaching Zephaniah meant dragging a scrollbar during a
 * service, and reaching 2 Corinthians meant knowing it is filed under "2". An
 * operator asked for suggestions while typing, and this is what they were
 * asking for: type three letters, press Enter.
 *
 * # What it will not do
 *
 * It never changes the value on its own. Typing filters; only Enter, a click
 * or a highlighted arrow choice commits, and leaving the box puts back the
 * name of whatever is actually chosen. A picker that guessed as you typed
 * would move the chapter under an operator halfway through a word.
 */
export function ComboBox({
  value,
  choices,
  onChoose,
  label,
  className = "",
}: {
  value: string;
  choices: Choice[];
  onChoose: (value: string) => void;
  /** For screen readers, and for the placeholder when nothing is chosen. */
  label: string;
  className?: string;
}) {
  const chosen = choices.find((choice) => choice.value === value);
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const showing = open ? choices.filter((choice) => matches(choice, typed)) : [];

  // Closing on a click elsewhere rather than on blur: blur fires before the
  // click that chose something, which would close the list out from under the
  // press that was choosing from it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setOpen(false);
        setTyped("");
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const take = (choice: Choice) => {
    onChoose(choice.value);
    setOpen(false);
    setTyped("");
  };

  return (
    <div ref={box} className={`relative ${className}`}>
      <input
        value={open ? typed : (chosen?.label ?? "")}
        aria-label={label}
        placeholder={label}
        spellCheck={false}
        onFocus={() => {
          setOpen(true);
          setTyped("");
          setAt(0);
        }}
        onChange={(event) => {
          setTyped(event.target.value);
          setOpen(true);
          setAt(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            setAt((was) => {
              const next = was + (event.key === "ArrowDown" ? 1 : -1);
              return Math.min(Math.max(next, 0), Math.max(showing.length - 1, 0));
            });
            return;
          }
          if (event.key === "Enter") {
            const pick = showing[at];
            if (pick) {
              event.preventDefault();
              event.stopPropagation();
              take(pick);
            }
            return;
          }
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setTyped("");
          }
        }}
        className="w-full min-w-0 truncate rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-1.5 text-[12px] text-pulpitry-text outline-none focus-visible:focus-ring"
      />

      {open && showing.length > 0 ? (
        <ul className="absolute top-full right-0 left-0 z-30 mt-0.5 max-h-64 overflow-auto rounded border border-pulpitry-line bg-pulpitry-surface py-0.5 shadow-lg">
          {showing.map((choice, index) => (
            <li key={choice.value}>
              <button
                type="button"
                // The press itself, rather than a click: mousedown would beat
                // the input's own blur handling and this has to win.
                onMouseDown={(event) => {
                  event.preventDefault();
                  take(choice);
                }}
                onMouseEnter={() => setAt(index)}
                className={`flex w-full items-baseline gap-2 px-2 py-1 text-left text-[12px] transition-colors ${
                  index === at
                    ? "bg-pulpitry-teal-dim text-pulpitry-text"
                    : "text-pulpitry-text hover:bg-pulpitry-raised"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                {choice.hint ? (
                  <span className="shrink-0 text-[11px] text-pulpitry-muted">
                    {choice.hint}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
