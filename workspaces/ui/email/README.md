# @dbx-tools/ui-email

React email surfaces for AppKit chat and admin workflows.

Import this package when a Databricks App needs to render model-drafted email,
collect a human approval decision, or provide a standalone compose form using
the same message contract as [`@dbx-tools/shared-email`](../../shared/email).
Server-side sending and AppKit routes live in
[`@dbx-tools/node-email`](../../node/email).

## Add The Styles

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-email/styles.css";
```

The stylesheet pulls in the AppKit UI base styles and scans the email React
components for Tailwind classes. Import it once from the app's global CSS entry.

## Render A Send Approval

```tsx
import { reactEmailApprovalCard } from "@dbx-tools/ui-email";
import { email } from "@dbx-tools/shared-email";

const draft = email.emailMessageSchema.parse(toolCall.args);

<reactEmailApprovalCard.EmailApprovalCard
  email={draft}
  pending={pending}
  onApprove={() => addToolResult({ toolCallId: toolCall.id, result: { approved: true } })}
  onDeny={() => addToolResult({ toolCallId: toolCall.id, result: { approved: false } })}
/>;
```

`EmailApprovalCard` is the chat-facing component for the `send_email` tool. It
renders the draft fields, Markdown body, attachment names, and Approve/Deny
actions while leaving tool-call state and transport decisions to the host app.

## Preview A Draft Inline

```tsx
import { reactEmailApprovalCard } from "@dbx-tools/ui-email";

<reactEmailApprovalCard.EmailPreview email={draft} />;
```

Use `EmailPreview` when a page needs a compact read-only summary without action
buttons, such as a review queue, audit log, or test harness.

## Provide A Compose View

```tsx
import { reactEmailCompose } from "@dbx-tools/ui-email";

<reactEmailCompose.EmailComposeView
  senders={senderOptions.senders}
  defaultFrom={senderOptions.defaultSender}
  onSend={(message, from) => sendEmail(message, from)}
/>;
```

`EmailComposeView` owns the form state, normalizes recipient fields, converts
attached files to base64 email attachments, and emits the assembled
`EmailMessage`. Fetch sender options and dispatch the final send through the
server package.

## Render A Markdown Body

```tsx
import { reactEmailBody } from "@dbx-tools/ui-email";

<reactEmailBody.EmailBody className="text-sm">{message.body}</reactEmailBody.EmailBody>;
```

`EmailBody` uses Streamdown to render compact Markdown for email text. It is
shared by the compose preview and approval card so drafts look the same before
and after submission.

## Reuse Field Helpers

```ts
import { reactFields } from "@dbx-tools/ui-email";

const to = reactFields.parseAddresses("alice@example.com; bob@example.com");
const label = reactFields.joinAddresses(to);
const files = reactFields.attachmentNames(message.attachments);
```

The helpers keep free-text recipient parsing and attachment labels consistent
across approval, compose, and custom UI surfaces.

## Modules

- `reactEmailApprovalCard` - `EmailPreview`, `EmailApprovalCard`, and
  approval-card prop types.
- `reactEmailCompose` - `EmailComposeView` and compose prop types.
- `reactEmailBody` - compact Markdown body renderer.
- `reactFields` - address parsing, display helpers, attachment labels, and the
  `EmailDraft` type.

Pair this package with [`@dbx-tools/node-email`](../../node/email) for SMTP or
outbox delivery, and with [`@dbx-tools/shared-email`](../../shared/email) for
schema validation in client/server boundaries.
