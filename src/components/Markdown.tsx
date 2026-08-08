import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a summary.
 *
 * CommonMark with the GitHub extensions, by a parser that implements them
 * properly. This started as a hand-rolled reader of six constructs and grew a
 * new edge case per test run -- nested lists, tables, a heading welded to a
 * sentence -- which is the point at which writing your own Markdown parser
 * stops being thrift and starts being a hobby.
 *
 * The same dialect the exporter reads, so what is on screen is what lands in
 * the PDF a church sends out.
 *
 * Nothing here renders HTML: `react-markdown` ignores raw tags unless a plugin
 * is added to allow them, and none is. A summary is model output, and model
 * output is not markup we should be executing.
 */

/** Tailwind is not in scope inside the markdown tree, so styles go per node. */
const styles = {
  h1: "mt-5 text-[15px] font-semibold tracking-tight text-pulpitry-text first:mt-0",
  h2: "mt-5 text-[11px] font-medium uppercase tracking-[0.14em] text-pulpitry-muted first:mt-0",
  h3: "mt-4 text-[13.5px] font-semibold text-pulpitry-text first:mt-0",
} as const;

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-3 ${className}`} data-selectable>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h4 className={styles.h1}>{children}</h4>,
          h2: ({ children }) => <h4 className={styles.h2}>{children}</h4>,
          h3: ({ children }) => <h5 className={styles.h3}>{children}</h5>,
          h4: ({ children }) => <h5 className={styles.h3}>{children}</h5>,

          p: ({ children }) => (
            <p className="text-[13.5px] leading-relaxed text-pulpitry-text">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-pulpitry-text">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => (
            <del className="text-pulpitry-muted line-through">{children}</del>
          ),

          ul: ({ children }) => (
            <ul className="ml-1 flex list-disc flex-col gap-1.5 pl-4 text-[13.5px] leading-relaxed marker:text-pulpitry-gold">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-1 flex list-decimal flex-col gap-2 pl-5 text-[13.5px] leading-relaxed marker:font-semibold marker:text-pulpitry-gold">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="text-pulpitry-text">{children}</li>,

          // Scripture, mostly. Ruled rather than indented, so it reads as
          // somebody else's words at a glance.
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-pulpitry-gold-dim pl-3 text-[13.5px] leading-relaxed text-pulpitry-muted italic">
              {children}
            </blockquote>
          ),

          hr: () => <hr className="my-1 border-pulpitry-line" />,

          // Its own scroll container: a wide table must never make the panel
          // scroll sideways.
          table: ({ children }) => (
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full border-collapse text-left text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-pulpitry-line py-1.5 pr-4 font-semibold text-pulpitry-text">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-pulpitry-line/60 py-1.5 pr-4 align-top text-pulpitry-muted">
              {children}
            </td>
          ),

          // A summary has no code in it, but a stray backtick should show its
          // contents rather than swallow them.
          code: ({ children }) => (
            <code className="rounded bg-pulpitry-raised px-1 py-0.5 text-[12.5px]">{children}</code>
          ),

          // Nothing here is clickable, and an underlined non-link is a lie.
          a: ({ children }) => <span className="text-pulpitry-text">{children}</span>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
