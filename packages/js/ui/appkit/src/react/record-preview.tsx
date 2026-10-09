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

const NESTED_DEPTH = 2;

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
  return (
    <div className={cn("relative min-w-0", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-pressed={raw}
            aria-label={raw ? "Show table" : "Show JSON"}
            className="absolute right-1 top-1 z-10 size-6"
            onClick={() => setRaw((current) => !current)}
          >
            {raw ? <Table2Icon className="size-3" /> : <BracesIcon className="size-3" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{raw ? "Table" : "JSON"}</TooltipContent>
      </Tooltip>
      {raw ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background/40 p-2 pr-8 font-mono text-[11px] leading-relaxed">
          {formatRecordPreviewJson(value)}
        </pre>
      ) : (
        <RecordTable rows={rows} depth={0} />
      )}
    </div>
  );
}

function RecordTable({ rows, depth }: { rows: RecordPreviewRow[]; depth: number }) {
  if (rows.length === 0) return null;
  return (
    <Table className="text-[11px]">
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key} className="hover:bg-transparent">
            <TableHead className="w-[8.5rem] align-top whitespace-nowrap px-2 py-1.5 font-medium text-muted-foreground">
              {row.label}
            </TableHead>
            <TableCell className="align-top break-words px-2 py-1.5 pr-8">
              <RecordValue value={row.value} depth={depth} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
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
  if (typeof value === "object" && !Array.isArray(value) && depth < NESTED_DEPTH) {
    return <RecordTable rows={recordPreviewRows(value)} depth={depth + 1} />;
  }
  if (Array.isArray(value) && value.every((item) => item == null || typeof item !== "object")) {
    return <span className="whitespace-pre-wrap break-words">{value.map(String).join(", ")}</span>;
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
      {formatRecordPreviewJson(value)}
    </pre>
  );
}
