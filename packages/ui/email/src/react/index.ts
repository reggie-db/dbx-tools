// React surface for `@dbx-tools/ui-email`: a read-only Approve / Deny card for
// the `send_email` tool's approval flow, the field preview it wraps, and a
// standard editable compose view for use outside a chat bubble. All three share
// `./fields` and `./email-body`, so a drafted message renders identically across
// them. Styled with AppKit tokens.

export type { EmailAttachment, EmailMessage } from "@dbx-tools/shared-email";
export {
  EmailApprovalCard,
  EmailPreview,
  type EmailApprovalCardProps,
  type EmailPreviewProps,
} from "./email-approval-card";
export { EmailBody, type EmailBodyProps } from "./email-body";
export { EmailComposeView, type EmailComposeProps } from "./email-compose";
export { attachmentNames, joinAddresses, parseAddresses } from "./fields";
export type { EmailDraft } from "./fields";
