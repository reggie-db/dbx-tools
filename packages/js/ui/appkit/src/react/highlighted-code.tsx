/**
 * Shared syntax-highlighted code surfaces for AppKit-oriented UI packages.
 *
 * @module
 */

import { json } from "@dbx-tools/shared-core";
import { useEffect, useState } from "react";

import { cn } from "./appkit-ui.ts";
import { highlightToHtml } from "./shiki-plugin.ts";

export { createShikiPlugin, highlightToHtml } from "./shiki-plugin.ts";

/** Code languages detected automatically in free-form text fields. */
export type DetectedCodeLanguage = "sql" | "python" | "typescript" | "bash" | "json";

/** Detect a supported code language from a complete free-form text value. */
export function detectCodeLanguage(source: string): DetectedCodeLanguage | undefined {
  const trimmed = source.trim();
  if (/^(?:select|with|insert|update|delete|merge|create|alter)\b/i.test(trimmed)) return "sql";
  if (/^(?:from\s+\S+\s+import|import\s+\S+|def\s+\w+|class\s+\w+):?/m.test(trimmed)) {
    return "python";
  }
  if (/^(?:const|let|var|interface|type|export|import)\b/m.test(trimmed)) return "typescript";
  if (/^(?:#!.*\b(?:ba|z|k)?sh\b|(?:cd|ls|cat|grep|find|bun|npm|pnpm|yarn)\s)/m.test(trimmed)) {
    return "bash";
  }
  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    trimmed.length > 1 &&
    json.parse(trimmed) !== undefined
  ) {
    return "json";
  }
  return undefined;
}

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

/** Render code with the shared lazily loaded Shiki runtime. */
export const HighlightedCodeBlock = ({
  source,
  language,
  className,
}: {
  source: string;
  language: string;
  className?: string;
}) => {
  const html = useHighlightedHtml(source, language);
  return (
    <pre
      data-language={language}
      className={cn(
        "max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
        className,
      )}
    >
      {html === null ? (
        <code>{source}</code>
      ) : (
        <code data-dbx-highlighted-code dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </pre>
  );
};

/** Render formatted JSON with the shared lazily loaded Shiki runtime. */
export const JsonBlock = ({ json, className }: { json: string; className?: string }) => (
  <HighlightedCodeBlock source={json} language="json" className={className} />
);
