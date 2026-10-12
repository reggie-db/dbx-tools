import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@dbx-tools/ui/react";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LinkSafetyModalProps } from "streamdown";
import { copyText } from "../support/clipboard.ts";

/** Display and clipboard values for one confirmed chat link. */
export interface LinkPresentation {
  displayUrl: string;
  absoluteUrl: string;
}

/**
 * Resolve a chat link for display and copying.
 *
 * Same-origin HTTP links are shown as a compact path while clipboard actions
 * keep the absolute URL. External origins and non-HTTP schemes remain fully
 * visible so the confirmation never obscures where the user is going.
 */
export function resolveLinkPresentation(url: string, baseUrl?: string): LinkPresentation {
  const fallback = { displayUrl: url, absoluteUrl: url };
  const base = baseUrl ?? (typeof window === "undefined" ? undefined : window.location.href);

  try {
    const resolved = base ? new URL(url, base) : new URL(url);
    const baseOrigin = base ? new URL(base).origin : undefined;
    const isWebLink = resolved.protocol === "http:" || resolved.protocol === "https:";
    const displayUrl = isWebLink && resolved.origin === baseOrigin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}` || "/"
      : resolved.href;
    return { displayUrl, absoluteUrl: resolved.href };
  } catch {
    return fallback;
  }
}

/** AppKit-styled confirmation shown before opening a link from assistant markdown. */
export const ExternalLinkDialog = ({
  isOpen,
  onClose,
  onConfirm,
  url,
}: LinkSafetyModalProps) => {
  const link = useMemo(() => resolveLinkPresentation(url), [url]);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyLink = () => {
    void copyText(link.absoluteUrl).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="border-border/60 p-5 shadow-2xl dark:border-white/10 sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
            Open external link?
          </AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;re about to visit a link outside this chat.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div
          className="max-h-32 overflow-y-auto break-all rounded-md bg-muted px-3 py-2 font-mono text-sm"
          title={link.absoluteUrl}
        >
          {link.displayUrl}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button type="button" variant="outline" onClick={copyLink}>
            {copied ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-4" aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <AlertDialogAction onClick={onConfirm}>
            <ExternalLinkIcon className="size-4" aria-hidden="true" />
            Open link
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
