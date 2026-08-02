import {
  EmailCard,
  emailBrandFromContext,
  type EmailBrand,
} from "@dbx-tools/shared-email-template";
import { Button } from "@dbx-tools/ui-appkit/react";
import { useBrand } from "@dbx-tools/ui-branding/react";
import { CheckIcon, MailIcon, XIcon } from "lucide-react";
import { attachmentNames, joinAddresses, type EmailDraft } from "./fields.ts";

// Presentational pieces for an outbound email awaiting a human Approve /
// Deny: the field preview (To / Cc / Subject / Body / Files, body rendered
// through the shared React Email presentation) and an approval card wrapping it.
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

/**
 * Render an email draft as a labelled `To` / `Cc` / `Subject` / `Body` /
 * `Files` list. `to` / `cc` may carry one or more addresses; the body is
 * rendered through the same React Email body used for delivery. Fields that
 * are empty are omitted.
 */
export const EmailPreview = ({ email, brand }: EmailPreviewProps) => {
  const { context } = useBrand();
  const to = joinAddresses(email.to);
  const cc = joinAddresses(email.cc);
  const bcc = joinAddresses(email.bcc);
  const attachments = attachmentNames(email.attachments);
  const headers: Array<readonly [string, string]> = [];
  if (to) headers.push(["To", to]);
  if (cc) headers.push(["Cc", cc]);
  if (bcc) headers.push(["Bcc", bcc]);
  if (attachments) headers.push(["Files", attachments]);
  return (
    <div className="overflow-x-auto rounded-2xl bg-muted/20 p-2">
      <EmailCard
        subject={email.subject || "Message"}
        body={email.body || ""}
        headers={headers}
        brand={brand ?? emailBrandFromContext(context)}
      />
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
