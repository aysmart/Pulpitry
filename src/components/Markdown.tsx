import { parseMarkdown, type Span } from "../lib/markdown";

/**
 * Renders a summary.
 *
 * The stored form is Markdown and this is the only thing that reads it for the
 * screen; every export converts from the same text. Nothing here interprets
 * HTML, so a model that returns a tag shows the tag.
 */

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.bold) {
          return (
            <strong key={index} className="font-semibold text-pulpitry-text">
              {span.text}
            </strong>
          );
        }
        if (span.italic) {
          return (
            <em key={index} className="italic">
              {span.text}
            </em>
          );
        }
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);

  return (
    <div className={`flex flex-col gap-3 ${className}`} data-selectable>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <h4
                key={index}
                className={`text-pulpitry-text ${
                  block.level <= 2
                    ? "mt-1 text-[13px] tracking-[0.08em] uppercase text-pulpitry-muted"
                    : "text-[13.5px] font-semibold"
                }`}
              >
                <Spans spans={block.spans} />
              </h4>
            );

          case "bullets":
            return (
              <ul key={index} className="flex flex-col gap-1.5">
                {block.items.map((item, itemIndex) => (
                  <li
                    key={itemIndex}
                    className="flex gap-2 text-[13.5px] leading-relaxed text-pulpitry-text"
                  >
                    <span aria-hidden="true" className="select-none text-pulpitry-gold">
                      •
                    </span>
                    <span className="min-w-0">
                      <Spans spans={item} />
                    </span>
                  </li>
                ))}
              </ul>
            );

          case "paragraph":
            return (
              <p key={index} className="text-[13.5px] leading-relaxed text-pulpitry-text">
                <Spans spans={block.spans} />
              </p>
            );
        }
      })}
    </div>
  );
}
