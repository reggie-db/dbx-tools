/**
 * Shared syntax-highlighted code surfaces for AppKit-oriented UI packages.
 *
 * @module
 */

import { useEffect, useState } from "react";

import { cn } from "./appkit-ui.ts";
import { highlightToHtml } from "./shiki-plugin.ts";

export { createShikiPlugin, highlightToHtml } from "./shiki-plugin.ts";

/** Resolve syntax-highlighted HTML while preserving plaintext during lazy load. */
export function useHighlightedHtml(source: string, language: string): string | null {
  const [highlighted, setHighlighted] = useState<{
    source: string;
    language: string;
    html: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void highlightToHtml(source, language).then((result) => {
      if (active) setHighlighted({ source, language, html: result });
    });
    return () => {
      active = false;
    };
  }, [language, source]);
  return highlighted?.source === source && highlighted.language === language
    ? highlighted.html
    : null;
}

/** Render formatted JSON with the shared lazily loaded Shiki runtime. */
export const JsonBlock = ({ json, className }: { json: string; className?: string }) => {
  const html = useHighlightedHtml(json, "json");
  return (
    <pre
      className={cn(
        "max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
        className,
      )}
    >
      {html === null ? (
        <code>{json}</code>
      ) : (
        <code data-dbx-highlighted-code dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </pre>
  );
};
