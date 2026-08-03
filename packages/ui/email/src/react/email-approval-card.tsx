import {
  EmailCard,
  emailBrandFromContext,
  resolveEmailBrand,
  type EmailBrand,
} from "@dbx-tools/shared-email-template";
import { Button } from "@dbx-tools/ui-appkit/react";
import { useBrand } from "@dbx-tools/ui-branding/react";
import { CheckIcon, MailIcon, PaperclipIcon, XIcon } from "lucide-react";
import { attachmentNames, joinAddresses, type EmailDraft } from "./fields.ts";

// Presentational pieces for an outbound email awaiting a human Approve /
// Deny: a mail-client chrome (sender, recipients, subject, attachments)
// around the shared React Email card, plus an approval card wrapping it.
// State and the resolve transport belong to the caller; these components
// only render and report intent. The editable counterpart is
// `EmailComposeView` in `./email-compose`; both share `./fields` and
// `./email-body`.

export type { EmailDraft } from "./fields.ts";

/** Props for {@link EmailPreview}. */
export interface EmailPreviewProps {
  email: EmailDraft;
  /** Optional email-only brand. Defaults to the active `BrandProvider` context. */
  brand?: EmailBrand;
}

/** Initials for the sender avatar when no logo is available. */
function senderInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

/** One muted "Label: value" row in the client chrome. */
const ChromeRow = ({ label, value }: { label: string; value: string }) => (
  <p className="truncate text-xs text-muted-foreground">
    <span className="font-medium text-foreground/70">{label}</span> {value}
  </p>
);

/**
 * Render an email draft the way a mail client shows a received message: sender
 * identity, recipients, subject, and attachment chips in chrome around the
 * same branded React Email card used for delivery. Envelope fields stay out of
 * the delivered HTML — they are transport metadata, not body content.
 */
export const EmailPreview = ({ email, brand }: EmailPreviewProps) => {
  const { context } = useBrand();
  const theme = resolveEmailBrand(brand ?? emailBrandFromContext(context));
  const to = joinAddresses(email.to);
  const cc = joinAddresses(email.cc);
  const bcc = joinAddresses(email.bcc);
  const subject = email.subject?.trim() || "Message";
  const files = email.attachments?.map((att) => att.filename).filter(Boolean) ?? [];
  const attachmentSummary = attachmentNames(email.attachments);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="space-y-3 border-b border-border bg-background px-4 py-3">
        <div className="flex items-start gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{ backgroundColor: theme.accent, color: theme.onAccent }}
            aria-hidden
          >
            {senderInitials(theme.name)}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{theme.name}</p>
                {theme.website ? (
                  <p className="truncate text-xs text-muted-foreground">{theme.website}</p>
                ) : null}
              </div>
              <time className="shrink-0 text-xs text-muted-foreground">Just now</time>
            </div>
            {to ? <ChromeRow label="To" value={to} /> : null}
            {cc ? <ChromeRow label="Cc" value={cc} /> : null}
            {bcc ? <ChromeRow label="Bcc" value={bcc} /> : null}
            <p className="pt-1 text-sm font-medium leading-snug text-foreground">{subject}</p>
          </div>
        </div>
        {files.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={`Attachments: ${attachmentSummary}`}>
            {files.map((filename) => (
              <li
                key={filename}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground"
              >
                <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{filename}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="bg-muted/30 p-3">
        <EmailCard subject={subject} body={email.body || ""} brand={theme} />
      </div>
    </div>
  );
};

/** Props for {@link EmailApprovalCard}. */
export interface EmailApprovalCardProps {
  email: EmailDraft;
  /** Called when the user approves the send. */
  onApprove?: () => void | Promise<void>;
  /** Called when the user denies the send. */
  onDeny?: () => void | Promise<void>;
  /** Disable both actions while a decision is in flight. */
  pending?: boolean;
  /** Disable both actions regardless of pending state. */
  disabled?: boolean;
  /** Header label. Defaults to "Approval needed: send email". */
  title?: string;
}

/**
 * A drop-in approval card for the `send_email` tool: the email preview
 * plus Approve / Deny actions. Wire `onApprove` / `onDeny` to whatever
 * resumes the suspended tool call (e.g. the AI-SDK `addToolResult`).
 */
export const EmailApprovalCard = ({
  email,
  onApprove,
  onDeny,
  pending,
  disabled,
  title = "Approval needed: send email",
}: EmailApprovalCardProps) => {
  const blocked = Boolean(disabled) || Boolean(pending);
  return (
    <div className="not-prose my-2 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-warning">
        <MailIcon className="size-3.5" />
        <span>{title}</span>
      </div>
      <EmailPreview email={email} />
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          disabled={blocked || !onApprove}
          onClick={() => onApprove?.()}
        >
          <CheckIcon className="size-3" />
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={blocked || !onDeny}
          onClick={() => onDeny?.()}
        >
          <XIcon className="size-3" />
          Deny
        </Button>
      </div>
    </div>
  );
};
