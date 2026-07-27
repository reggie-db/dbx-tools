import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@dbx-tools/ui-appkit/react";
import { DownloadIcon, FileTextIcon } from "lucide-react";
import type { ExportFormat } from "../support/export";

// Shared export affordance: a download button that opens a small menu of
// output formats. Reused for both the whole-conversation export (header,
// labelled) and per-message export (bubble action row, icon-only).

/** Menu entries, in display order. */
const FORMATS: ReadonlyArray<{
  format: ExportFormat;
  label: string;
  Icon: typeof DownloadIcon;
}> = [
  { format: "pdf", label: "PDF", Icon: DownloadIcon },
  { format: "markdown", label: "Markdown", Icon: FileTextIcon },
];

/**
 * Export dropdown. Fires {@link onExport} with the chosen
 * {@link ExportFormat}. `iconOnly` renders a compact icon trigger (used
 * inside message bubbles) with the label surfaced as a tooltip; the
 * default renders an icon + "Export" text button (used in the header).
 */
export const ExportMenu = ({
  onExport,
  iconOnly = false,
  tooltip = "Export",
}: {
  onExport: (format: ExportFormat) => void;
  iconOnly?: boolean;
  tooltip?: string;
}) => {
  const trigger = iconOnly ? (
    <Button type="button" size="icon" variant="ghost" className="size-7">
      <DownloadIcon className="size-3" />
    </Button>
  ) : (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1 rounded-full px-2.5 text-xs [&_svg]:size-3"
    >
      <DownloadIcon className="size-3" />
      Export
    </Button>
  );

  return (
    <DropdownMenu>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end">
        {FORMATS.map(({ format, label, Icon }) => (
          <DropdownMenuItem key={format} onClick={() => onExport(format)}>
            <Icon className="size-3.5" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
