// React surface for `@dbx-tools/ui-email`: a read-only Approve / Deny card for
// the `send_email` tool's approval flow, the field preview it wraps, a standard
// editable compose view for use outside a chat bubble, and the `AuthGate`
// email-OTP login screen for an app fronted by the email auth plugin. The email
// components share `./fields` and `./email-body`, so a drafted message renders
// identically across them. Styled with AppKit tokens.

export type { EmailAttachment, EmailMessage } from "@dbx-tools/shared-email";
export { AuthGate, type AuthGateProps } from "./auth-gate.tsx";
export {
  EmailApprovalCard,
  EmailPreview,
  type EmailApprovalCardProps,
  type EmailPreviewProps,
} from "./email-approval-card.tsx";
export { EmailBody, type EmailBodyProps } from "./email-body.tsx";
export { EmailComposeView, type EmailComposeProps } from "./email-compose.tsx";
export { attachmentNames, joinAddresses, parseAddresses } from "./fields.ts";
export type { EmailDraft } from "./fields.ts";
