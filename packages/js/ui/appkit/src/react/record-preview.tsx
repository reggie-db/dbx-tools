/**
 * Humanized key/value table for arbitrary JSON, with an icon toggle to
 * the raw document.
 *
 * @module
 */

import { BracesIcon, Table2Icon } from "lucide-react";
import { useState } from "react";
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
import { JsonBlock } from "./highlighted-code.tsx";
import {
  formatRecordPreviewJson,
  looksLikeMarkdown,
  markdownForPreview,
  recordPreviewRows,
  type RecordPreviewRow,
} from "./record-preview-data.ts";

export type { RecordPreviewRow } from "./record-preview-data.ts";
export {
  formatRecordPreviewJson,
  looksLikeMarkdown,
  markdownForPreview,
  recordPreviewRows,
} from "./record-preview-data.ts";

/** Compact Streamdown in a table cell: match 11px rows, keep lists tight. */
const MARKDOWN_CELL_CLASSES =
  "min-w-0 max-w-full text-[11px] leading-snug [&_p]:my-0.5 [&_p]:leading-snug [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_h1]:my-1 [&_h1]:text-[11px] [&_h1]:font-semibold [&_h2]:my-1 [&_h2]:text-[11px] [&_h2]:font-semibold [&_h3]:my-1 [&_h3]:text-[11px] [&_h3]:font-semibold [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background/60 [&_pre]:p-1.5 [&_pre]:text-[10px] [&_code]:text-[10px]";

const NESTED_DEPTH = 4;

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
  const scalarRows = rows.filter((row) => !isNestedValue(row.value));
  const nestedRows = rows.filter((row) => isNestedValue(row.value));
  return (
    <div className="min-w-0 px-2 pb-2">
      {scalarRows.length > 0 ? <ScalarTable rows={scalarRows} /> : null}
      {nestedRows.map((row) => (
        <RecordGroup key={row.key} row={row} depth={0} />
      ))}
    </div>
  );
}

function ScalarTable({ rows }: { rows: RecordPreviewRow[] }) {
  return (
    <Table className="table-fixed text-[11px]">
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} className="hover:bg-transparent">
            <TableHead className="h-auto w-28 align-top whitespace-normal px-0 py-1.5 pr-2 font-medium text-muted-foreground sm:w-[8.5rem]">
              {row.label}
            </TableHead>
            <TableCell className="min-w-0 whitespace-normal px-0 py-1.5 pr-8 align-top [overflow-wrap:anywhere]">
              <RecordValue value={row.value} depth={0} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RecordGroup({ row, depth }: { row: RecordPreviewRow; depth: number }) {
  return (
    <section className="mt-2.5 min-w-0 first:mt-2">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {row.label}
      </h3>
      <div className="min-w-0 border-l-2 border-border/70 pl-2.5">
        <NestedValue value={row.value} depth={depth + 1} />
      </div>
    </section>
  );
}

function NestedValue({ value, depth }: { value: unknown; depth: number }) {
  if (depth > NESTED_DEPTH) return <RecordValue value={value} depth={depth} />;
  if (Array.isArray(value)) {
    return (
      <div className="min-w-0 divide-y divide-border/60">
        {value.map((item, index) => (
          <div key={index} className="min-w-0 py-1.5 first:pt-0 last:pb-0">
            <NestedItem value={item} depth={depth} />
          </div>
        ))}
      </div>
    );
  }
  if (value != null && typeof value === "object") {
    const rows = recordPreviewRows(value);
    return (
      <div className="min-w-0">
        {rows.map((row) =>
          isNestedValue(row.value) ? (
            <RecordGroup key={row.key} row={row} depth={depth} />
          ) : (
            <StackedField key={row.key} row={row} depth={depth} />
          ),
        )}
      </div>
    );
  }
  return <RecordValue value={value} depth={depth} />;
}

function NestedItem({ value, depth }: { value: unknown; depth: number }) {
  if (value != null && typeof value === "object") {
    return <NestedValue value={value} depth={depth} />;
  }
  return <RecordValue value={value} depth={depth} />;
}

function StackedField({ row, depth }: { row: RecordPreviewRow; depth: number }) {
  return (
    <div className="min-w-0 border-b border-border/60 py-1.5 last:border-b-0">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {row.label}
      </span>
      <div className="min-w-0 text-[11px] leading-snug [overflow-wrap:anywhere]">
        <RecordValue value={row.value} depth={depth} />
      </div>
    </div>
  );
}

function isNestedValue(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  if (!Array.isArray(value)) return true;
  return value.some((item) => item != null && typeof item === "object");
}

function RecordValue({ value, depth }: { value: unknown; depth: number }) {
  if (value == null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="tabular-nums">{String(value)}</span>;
  }
  if (typeof value === "string") {
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
    if (depth < NESTED_DEPTH) {
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
