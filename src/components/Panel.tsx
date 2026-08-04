import type { ReactNode } from "react";

type Accent = "neutral" | "gold" | "teal";

const ACCENT_TEXT: Record<Accent, string> = {
  neutral: "text-pulpitry-muted",
  gold: "text-pulpitry-gold",
  teal: "text-pulpitry-teal",
};

/**
 * Shared panel chrome. `accent` is how a panel declares what it belongs to:
 * gold for anything live, teal for the verse detection system.
 */
export function Panel({
  title,
  accent = "neutral",
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  accent?: Accent;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-pulpitry-line bg-pulpitry-surface ${className}`}
    >
      {/* min-h rather than h: the library's tab strip has outgrown one row
          twice now, and wrapping is better than silently clipping a tab. */}
      <header className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-pulpitry-line px-3 py-1">
        {/* A panel whose tabs already name its contents passes an empty title
            rather than spending header width saying so twice. */}
        {title ? (
          <h2 className={`text-[11px] tracking-[0.14em] uppercase ${ACCENT_TEXT[accent]}`}>
            {title}
          </h2>
        ) : null}
        {actions}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Placeholder body for panels whose feature lands in a later phase. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-8 text-center">
      <p className="max-w-[26ch] text-[13px] leading-relaxed text-pulpitry-muted">{children}</p>
    </div>
  );
}
