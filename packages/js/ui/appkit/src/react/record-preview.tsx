/**
 * Humanized key/value table for arbitrary JSON, with an icon toggle to
 * the raw document.
 *
 * @module
 */

import { BracesIcon, Table2Icon } from "lucide-react";
import { Fragment, useState } from "react";
import { Streamdown } from "streamdown";

import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "./appkit-ui.ts";
import { detectCodeLanguage, HighlightedCodeBlock, JsonBlock } from "./highlighted-code.tsx";
import {
  formatRecordPreviewJson,
  looksLikeMarkdown,
  markdownForPreview,
  parseNestedJsonText,
  recordPreviewRows,
  type RecordPreviewRow,
} from "./record-preview-data.ts";

export type { RecordPreviewRow } from "./record-preview-data.ts";
export {
  formatRecordPreviewJson,
  looksLikeMarkdown,
  markdownForPreview,
  parseNestedJsonText,
  recordPreviewRows,
} from "./record-preview-data.ts";

/** Compact Streamdown in a table cell: match 11px rows, keep lists tight. */
const MARKDOWN_CELL_CLASSES =
  "min-w-0 max-w-full text-[11px] leading-snug [&_p]:my-0.5 [&_p]:leading-snug [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_h1]:my-1 [&_h1]:text-[11px] [&_h1]:font-semibold [&_h2]:my-1 [&_h2]:text-[11px] [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:text-[11px] [&_h3]:font-semibold [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background/60 [&_pre]:p-1.5 [&_pre]:text-[10px] [&_code]:text-[10px]";

const MAX_NESTED_DEPTH = 12;
const MAX_INDENT_DEPTH = 4;

/** Props for {@link RecordPreview}. */
export interface RecordPreviewProps {
  /** JSON-shaped value to display. */
  value: unknown;
  /** Extra classes on the outer frame. */
  className?: string;
}

/** Compact labeled table of a JSON object, with a JSON/raw icon toggle. */
export function RecordPreview({ value, className }: RecordPreviewProps) {
  const [raw, setRaw] = useState(false);
  const rows = recordPreviewRows(value);
  const rawJson = formatRecordPreviewJson(value);
  return (
    <div
      className={cn(
        "relative min-w-0 [&_[data-slot=table-container]]:overflow-x-hidden",
        className,
      )}
    >
      <div className="sticky top-1 z-10 float-right mr-1 h-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-pressed={raw}
              aria-label={raw ? "Show table" : "Show JSON"}
              className="size-6 bg-background/85 backdrop-blur-sm"
              onClick={() => setRaw((current) => !current)}
            >
              {raw ? <Table2Icon className="size-3" /> : <BracesIcon className="size-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{raw ? "Table" : "JSON"}</TooltipContent>
        </Tooltip>
      </div>
      {raw ? (
        <JsonBlock json={rawJson} className="rounded bg-background/40 p-2 pr-8 text-[11px]" />
      ) : rows.length === 0 ? (
        <pre className="whitespace-pre-wrap break-words rounded bg-background/40 p-2 pr-8 font-mono text-[11px] leading-relaxed">
          {rawJson}
        </pre>
      ) : (
        <RecordTable rows={rows} />
      )}
    </div>
  );
}

function RecordTable({ rows }: { rows: RecordPreviewRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0 px-2 pb-2">
      <Table className="table-fixed text-[11px]">
        <TableBody>
          {rows.map((row) => (
            <RecordRow key={row.key} row={row} depth={0} path={row.key} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RecordRow({
  row,
  depth,
  path,
  divided,
}: {
  row: RecordPreviewRow;
  depth: number;
  path: string;
  divided?: boolean;
}) {
  const nested = nestedRecordValue(row.value);
  if (!nested) {
    return <FieldRow row={row} depth={depth} divided={divided} />;
  }
  return (
    <Fragment>
      <SectionRow
        label={row.label}
        depth={depth}
        divided={divided}
        parsedFromText={nested.parsedFromText}
      />
      <NestedRows value={nested.value} depth={depth + 1} path={path} />
    </Fragment>
  );
}

function FieldRow({
  row,
  depth,
  divided,
}: {
  row: RecordPreviewRow;
  depth: number;
  divided?: boolean;
}) {
  return (
    <TableRow className={cn("hover:bg-transparent", divided && "border-t-2 border-border/50")}>
      <TableHead
        className="h-auto w-28 align-top whitespace-normal px-0 py-1.5 pr-2 font-medium text-muted-foreground sm:w-[8.5rem]"
        style={{ paddingLeft: rowIndent(depth) }}
      >
        {row.label}
      </TableHead>
      <TableCell className="min-w-0 whitespace-normal px-0 py-1.5 pr-8 align-top [overflow-wrap:anywhere]">
        <RecordValue value={row.value} depth={depth} />
      </TableCell>
    </TableRow>
  );
}

function SectionRow({
  label,
  depth,
  divided,
  parsedFromText,
}: {
  label: string;
  depth: number;
  divided?: boolean;
  parsedFromText: boolean;
}) {
  return (
    <TableRow
      className={cn("border-b-0 hover:bg-transparent", divided && "border-t-2 border-border/50")}
    >
      <TableHead
        colSpan={2}
        className="h-auto px-0 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-foreground/85"
        style={{ paddingLeft: rowIndent(depth) }}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {parsedFromText ? (
            <BracesIcon
              className="size-3 text-muted-foreground"
              aria-label="JSON parsed from text"
            />
          ) : null}
        </span>
      </TableHead>
    </TableRow>
  );
}

function NestedRows({ value, depth, path }: { value: unknown; depth: number; path: string }) {
  if (depth > MAX_NESTED_DEPTH) {
    return <ValueRow value={value} depth={depth} />;
  }
  if (Array.isArray(value)) {
    return (
      <Fragment>
        {value.map((item, index) => (
          <ArrayItemRows
            key={`${path}.${index}`}
            value={item}
            depth={depth}
            path={`${path}.${index}`}
            divided={index > 0}
          />
        ))}
      </Fragment>
    );
  }
  if (value != null && typeof value === "object") {
    const rows = recordPreviewRows(value);
    if (rows.length === 0) return <ValueRow value={value} depth={depth} />;
    return (
      <Fragment>
        {rows.map((row) => (
          <RecordRow
            key={`${path}.${row.key}`}
            row={row}
            depth={depth}
            path={`${path}.${row.key}`}
          />
        ))}
      </Fragment>
    );
  }
  return <ValueRow value={value} depth={depth} />;
}

function ArrayItemRows({
  value,
  depth,
  path,
  divided,
}: {
  value: unknown;
  depth: number;
  path: string;
  divided: boolean;
}) {
  const nested = nestedRecordValue(value);
  if (nested?.parsedFromText) {
    return (
      <Fragment>
        <NestedTextMarkerRow depth={depth} divided={divided} />
        <NestedRows value={nested.value} depth={depth + 1} path={path} />
      </Fragment>
    );
  }
  if (value != null && typeof value === "object") {
    const rows = recordPreviewRows(value);
    if (rows.length === 0) return <ValueRow value={value} depth={depth} divided={divided} />;
    return (
      <Fragment>
        {rows.map((row, index) => (
          <RecordRow
            key={`${path}.${row.key}`}
            row={row}
            depth={depth}
            path={`${path}.${row.key}`}
            divided={divided && index === 0}
          />
        ))}
      </Fragment>
    );
  }
  return <ValueRow value={value} depth={depth} divided={divided} />;
}

function NestedTextMarkerRow({ depth, divided }: { depth: number; divided: boolean }) {
  return (
    <TableRow className={cn("border-b-0 hover:bg-transparent", divided && "border-t-2")}>
      <TableHead
        colSpan={2}
        className="h-auto px-0 pb-0.5 pt-2 text-muted-foreground"
        style={{ paddingLeft: rowIndent(depth) }}
      >
        <BracesIcon className="size-3" aria-label="JSON parsed from text" />
      </TableHead>
    </TableRow>
  );
}

function ValueRow({ value, depth, divided }: { value: unknown; depth: number; divided?: boolean }) {
  return (
    <TableRow className={cn("hover:bg-transparent", divided && "border-t-2 border-border/50")}>
      <TableHead
        aria-hidden
        className="h-auto w-28 px-0 py-1.5 pr-2 sm:w-[8.5rem]"
        style={{ paddingLeft: rowIndent(depth) }}
      />
      <TableCell className="min-w-0 whitespace-normal px-0 py-1.5 pr-8 align-top [overflow-wrap:anywhere]">
        <RecordValue value={value} depth={depth} />
      </TableCell>
    </TableRow>
  );
}

function rowIndent(depth: number): string {
  return `${Math.min(depth, MAX_INDENT_DEPTH) * 0.9}rem`;
}

function nestedRecordValue(
  value: unknown,
): { value: Record<string, unknown> | unknown[]; parsedFromText: boolean } | undefined {
  const parsed = parseNestedJsonText(value);
  if (parsed) return { value: parsed, parsedFromText: true };
  if (value == null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    const hasNestedValue = value.some(
      (item) =>
        (item != null && typeof item === "object") || parseNestedJsonText(item) !== undefined,
    );
    if (!hasNestedValue) return undefined;
  }
  return {
    value: value as Record<string, unknown> | unknown[],
    parsedFromText: false,
  };
}

function RecordValue({ value, depth }: { value: unknown; depth: number }) {
  if (value == null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="tabular-nums">{String(value)}</span>;
  }
  if (typeof value === "string") {
    const language = detectCodeLanguage(value);
    if (language === "sql") {
      return (
        <HighlightedCodeBlock
          source={value}
          language={language}
          className="rounded bg-background/60 p-1.5 text-[10px]"
        />
      );
    }
    if (looksLikeMarkdown(value)) {
      return (
        <div className={MARKDOWN_CELL_CLASSES}>
          <Streamdown controls={false}>{markdownForPreview(value)}</Streamdown>
        </div>
      );
    }
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => item == null || typeof item !== "object")) {
      return (
        <span className="whitespace-pre-wrap break-words">{value.map(String).join(", ")}</span>
      );
    }
    if (depth < MAX_NESTED_DEPTH) {
      return (
        <div className="min-w-0 divide-y divide-border/60">
          {value.map((item, index) => (
            <div key={index} className="min-w-0 py-1 first:pt-0 last:pb-0">
              <RecordValue value={item} depth={depth + 1} />
            </div>
          ))}
        </div>
      );
    }
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
      {formatRecordPreviewJson(value)}
    </pre>
  );
}
