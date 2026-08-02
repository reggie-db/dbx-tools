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
- Shared React Email body renderer matching the delivered message.
- dbx-tools branding by default, with consumer brand overrides available.
- Recipient parsing, address display, and attachment-label helpers that mirror
  server expectations.
- `AuthGate` sign-in screen for the email one-time-code auth plugin, branded from
  the shared brand context and shaped for platform autofill.
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
renders the complete branded React Email card, including envelope metadata and
attachments, plus Approve/Deny actions while leaving tool-call state and
transport decisions to the host app.

Wire `onApprove` and `onDeny` to the chat framework's tool-result mechanism.
The component deliberately does not call the email API itself; the server-side
tool resumes only after the host app records the user's decision.

## Preview A Draft Inline

```tsx
import { EmailPreview } from "@dbx-tools/ui-email/react";

<EmailPreview email={draft} />;
```

Use `EmailPreview` when a page needs the same full branded card without action
buttons, such as a review queue, audit log, or test harness. It projects the
nearest `BrandProvider` context into email-safe colors and typography, so a live
site brand picker updates the preview too. Pass the optional `brand` prop when a
specific message needs an independent campaign or partner identity.

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

## Render An Email Body

```tsx
import { EmailBody } from "@dbx-tools/ui-email/react";

<EmailBody className="text-sm">{message.body}</EmailBody>;
```

`EmailBody` reuses `@dbx-tools/shared-email-template`, the same React Email body
component used by the server renderer. Drafts therefore keep the delivered
message's typography, rich-content styling, and default brand while they are
edited and approved.

## Reuse Field Helpers

```ts
import { attachmentNames, joinAddresses, parseAddresses } from "@dbx-tools/ui-email/react";

const to = parseAddresses("alice@example.com; bob@example.com");
const label = joinAddresses(to);
const files = attachmentNames(message.attachments);
```

The helpers keep free-text recipient parsing and attachment labels consistent
across approval, compose, and custom UI surfaces.

## Gate An App Behind An Email Code

```tsx
import { AuthGate } from "@dbx-tools/ui-email/react";

<AuthGate>
  <App />
</AuthGate>;
```

`AuthGate` is the sign-in screen for an app fronted by the `@dbx-tools/email`
auth plugin - typically one published through
[`@dbx-tools/cli-tunnel`](../../cli/tunnel), where the hosting platform's own
identity-aware proxy is not in the request path. It calls the plugin's
`/api/email/auth/*` routes: on mount it checks `status`, renders `children`
straight through when the gate is off or a session already exists, and otherwise
runs the email -> code flow, revealing `children` once a verified code sets the
session cookie.

It holds no token: the session lives in an HttpOnly cookie the browser sends
automatically. `title` and `description` override the default copy, which
otherwise names the app from the brand context.

Before requesting a code, the email field requires exactly one address parsed
and validated by `@dbx-tools/shared-core`'s `net.parseEmails` + `net.isEmail`.
Malformed or multi-address input stays in the browser and never reaches the auth
endpoint.

The code field carries `autocomplete="one-time-code"`, which is what lets iOS,
Android, and Safari offer the code straight from the notification. That only pays
off while the email keeps the conventional `Your verification code is: / <code>`
shape the gate sends, so change one and check the other.

## Modules

- `./react` - `EmailPreview`, `EmailApprovalCard`, `EmailComposeView`,
  `EmailBody`, `AuthGate`, address/attachment helpers, shared email message
  types, and prop types.
- `./styles.css` - Tailwind/AppKit style entrypoint for the email components.

Pair this package with [`@dbx-tools/email`](../../node/email) for SMTP or
outbox delivery, [`@dbx-tools/shared-email-template`](../../shared/email-template)
for the universal presentation, and [`@dbx-tools/shared-email`](../../shared/email)
for schema validation in client/server boundaries.
