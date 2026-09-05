import { Fragment, type ReactNode } from "react";

/**
 * A deliberately tiny Markdown subset renderer.
 *
 * Eight seeded posts do not justify a Markdown dependency, a parser to keep patched, or
 * the `dangerouslySetInnerHTML` that most of them lead to. This handles exactly the
 * constructs the posts use — `##`/`###` headings, `-` bullets, `1.` numbered lists,
 * `>` pull quotes and paragraphs, with `**bold**` and `*italic*` inline — and renders
 * everything as React elements, so nothing here can inject markup.
 *
 * Anything it does not recognise falls through as paragraph text rather than vanishing.
 */

const BOLD_OR_ITALIC = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(BOLD_OR_ITALIC)
    .filter((chunk) => chunk !== "")
    .map((chunk, i) => {
      const key = `${keyPrefix}-${i}`;
      if (chunk.startsWith("**") && chunk.endsWith("**")) {
        return (
          <strong key={key} className="text-foreground font-semibold">
            {chunk.slice(2, -2)}
          </strong>
        );
      }
      if (chunk.startsWith("*") && chunk.endsWith("*")) {
        return <em key={key}>{chunk.slice(1, -1)}</em>;
      }
      return <Fragment key={key}>{chunk}</Fragment>;
    });
}

/** Splits on blank lines, so a block is a heading, a list, a quote or a paragraph. */
const blocksOf = (source: string) =>
  source
    .trim()
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b !== "");

export function Markdown({ source }: { source: string }) {
  return (
    <div className="text-foreground/85 space-y-5 text-[15px] leading-relaxed">
      {blocksOf(source).map((block, blockIndex) => {
        const key = `b${blockIndex}`;
        const lines = block.split("\n").map((l) => l.trim());

        if (block.startsWith("### ")) {
          return (
            <h3 key={key} className="font-display text-foreground pt-2 text-xl">
              {inline(block.slice(4), key)}
            </h3>
          );
        }

        if (block.startsWith("## ")) {
          return (
            <h2 key={key} className="font-display text-foreground pt-4 text-2xl">
              {inline(block.slice(3), key)}
            </h2>
          );
        }

        if (lines.every((l) => l.startsWith("> "))) {
          return (
            <blockquote
              key={key}
              className="border-leaf bg-sand font-display text-foreground border-l-4 px-5 py-4 text-lg"
            >
              {inline(lines.map((l) => l.slice(2)).join(" "), key)}
            </blockquote>
          );
        }

        if (lines.every((l) => l.startsWith("- "))) {
          return (
            <ul key={key} className="space-y-2 pl-1">
              {lines.map((l, i) => (
                <li key={`${key}-${i}`} className="flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className="bg-leaf mt-2 size-1.5 shrink-0 rounded-full"
                  />
                  <span>{inline(l.slice(2), `${key}-${i}`)}</span>
                </li>
              ))}
            </ul>
          );
        }

        if (lines.every((l) => /^\d+\.\s/.test(l))) {
          return (
            <ol key={key} className="list-decimal space-y-2 pl-5 marker:font-semibold">
              {lines.map((l, i) => (
                <li key={`${key}-${i}`}>{inline(l.replace(/^\d+\.\s/, ""), `${key}-${i}`)}</li>
              ))}
            </ol>
          );
        }

        return <p key={key}>{inline(lines.join(" "), key)}</p>;
      })}
    </div>
  );
}
