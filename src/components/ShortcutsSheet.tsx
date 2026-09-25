import { useEffect } from "react";

import { SHORTCUTS } from "../lib/shortcuts";

/**
 * What this desk answers to, on one sheet.
 *
 * There were eleven shortcuts and no way to find out: the arrows, Enter, Escape
 * and six accelerators on a menu bar most operators never open. An operator
 * asked for more, and the first thing to build was a way to know about the ones
 * that were already there.
 *
 * Grouped by the job rather than by the key, because nobody comes here asking
 * what B does -- they come asking how to take the screen down.
 */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const groups = SHORTCUTS.reduce<Record<string, typeof SHORTCUTS>>(
    (into, shortcut) => {
      (into[shortcut.group] ??= []).push(shortcut);
      return into;
    },
    {},
  );

  return (
    <div
      data-dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-[42rem] max-w-full flex-col overflow-hidden rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-baseline gap-3 border-b border-pulpitry-line px-4 py-3">
          <h2 className="text-[15px] text-pulpitry-text">Keyboard shortcuts</h2>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-pulpitry-muted">
            None of them fire while you are typing, or while a window like this
            one is open
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-pulpitry-line px-2.5 py-1 text-[12px] text-pulpitry-text transition-colors hover:border-pulpitry-gold focus-visible:focus-ring"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {Object.entries(groups).map(([group, rows]) => (
            <section key={group} className="mb-4 last:mb-0">
              <p className="mb-1.5 text-[11px] tracking-wide text-pulpitry-muted uppercase">
                {group}
              </p>
              <ul className="flex flex-col">
                {rows.map((shortcut) => (
                  <li
                    key={shortcut.does}
                    className="flex items-baseline gap-3 border-b border-pulpitry-line/60 py-1.5 last:border-0"
                  >
                    <span className="flex w-[11rem] shrink-0 flex-wrap items-center gap-1">
                      {shortcut.keys.map((key, at) => (
                        <kbd
                          key={at}
                          className="rounded border border-pulpitry-line bg-pulpitry-raised px-1.5 py-0.5 font-sans text-[11.5px] text-pulpitry-text"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                    <span className="text-[12.5px] leading-snug text-pulpitry-text">
                      {shortcut.does}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
