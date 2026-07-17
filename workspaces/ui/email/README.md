# @dbx-tools/ui-email

React email surfaces for AppKit chat and admin workflows.

Import this package when a Databricks App needs to render model-drafted email,
collect a human approval decision, or provide a standalone compose form using
the same message contract as [`@dbx-tools/shared-email`](../../shared/email).
Server-side sending and AppKit routes live in
[`@dbx-tools/email`](../../node/email).

Key features:

- Approval card for suspended `send_email` tool calls.
- Read-only draft preview for review queues, chat transcripts, and test pages.
- Standalone compose form that emits shared `EmailMessage` payloads.
- Compact Markdown body renderer shared across preview and compose surfaces.
- Recipient parsing, address display, and attachment-label helpers that mirror
  server expectations.
- Styles wired to the AppKit UI/Tailwind foundation so host apps do not need a
  separate email component theme.

## Add The Styles

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-email/styles.css";
```

The stylesheet pulls in the AppKit UI base styles and scans the email React
components for Tailwind classes. Import it once from the app's global CSS entry.

## Render A Send Approval

```tsx
import { EmailApprovalCard } from "@dbx-tools/ui-email/react";
import { email } from "@dbx-tools/shared-email";

const draft = email.emailMessageSchema.parse(toolCall.args);

<EmailApprovalCard
  email={draft}
  pending={pending}
  onApprove={() => addToolResult({ toolCallId: toolCall.id, result: { approved: true } })}
  onDeny={() => addToolResult({ toolCallId: toolCall.id, result: { approved: false } })}
/>;
```

`EmailApprovalCard` is the chat-facing component for the `send_email` tool. It
renders the draft fields, Markdown body, attachment names, and Approve/Deny
actions while leaving tool-call state and transport decisions to the host app.

Wire `onApprove` and `onDeny` to the chat framework's tool-result mechanism.
The component deliberately does not call the email API itself; the server-side
tool resumes only after the host app records the user's decision.

## Preview A Draft Inline

```tsx
import { EmailPreview } from "@dbx-tools/ui-email/react";

<EmailPreview email={draft} />;
```

Use `EmailPreview` when a page needs a compact read-only summary without action
buttons, such as a review queue, audit log, or test harness.

## Provide A Compose View

```tsx
import { EmailComposeView } from "@dbx-tools/ui-email/react";

<EmailComposeView
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
import { EmailBody } from "@dbx-tools/ui-email/react";

<EmailBody className="text-sm">{message.body}</EmailBody>;
```

`EmailBody` uses Streamdown to render compact Markdown for email text. It is
shared by the compose preview and approval card so drafts look the same before
and after submission.

## Reuse Field Helpers

```ts
import { attachmentNames, joinAddresses, parseAddresses } from "@dbx-tools/ui-email/react";

const to = parseAddresses("alice@example.com; bob@example.com");
const label = joinAddresses(to);
const files = attachmentNames(message.attachments);
```

The helpers keep free-text recipient parsing and attachment labels consistent
across approval, compose, and custom UI surfaces.

## Modules

- `./react` - `EmailPreview`, `EmailApprovalCard`, `EmailComposeView`,
  `EmailBody`, address/attachment helpers, shared email message types, and prop
  types.
- `./styles.css` - Tailwind/AppKit style entrypoint for the email components.

Pair this package with [`@dbx-tools/email`](../../node/email) for SMTP or
outbox delivery, and with [`@dbx-tools/shared-email`](../../shared/email) for
schema validation in client/server boundaries.
