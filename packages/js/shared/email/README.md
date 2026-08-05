# @dbx-tools/shared-email

Browser-safe email schemas and inferred types, for both things email is used for
here: SENDING a message, and using an emailed code to LOG IN.

Import this package when a UI, Mastra tool schema, server route, or test needs
to validate the same email payloads that
[`@dbx-tools/email`](../../node/email) sends, or the same one-time-code login
payloads that [`@dbx-tools/tunnel`](../../node/tunnel) and
[`@dbx-tools/cli-tunnel`](../../cli/tunnel) gate traffic with.

Key features:

- Shared `EmailMessage` contract for generated email drafts and direct sends.
- Attachment schema that supports inline content, file paths, URLs, encoding,
  and content-type hints.
- Send-result schema for SMTP and outbox responses.
- Sender-options schema for AppKit routes that expose allowed `From` values to
  a browser client.
- Model/tool-friendly schemas that avoid JSON Schema constraints known to cause
  problems with some serving endpoints.
- Email one-time-code ACCESS GATE contract: the request/verify/status payloads
  and the one session cookie name, so the two server paths that implement the
  gate and the React `AuthGate` that drives it validate against one definition.

## Validate A Drafted Message

```ts
import { email, type EmailMessage } from "@dbx-tools/shared-email";

const message: EmailMessage = email.emailMessageSchema.parse({
  to: ["alice@example.com"],
  subject: "Report",
  body: "# Done\nThe report is attached.",
  attachments: [{ filename: "report.csv", content: "a,b\n1,2\n" }],
});
```

The message schema covers recipients, subject, body content, and attachments.
Attachments can carry inline content, a local path, a URL, encoding metadata, and
content type hints.

## Validate Send Results

```ts
const result = email.emailResultSchema.parse(await sendResponse.json());
```

`emailResultSchema` is the shared shape for SMTP sends and outbox writes. Use it
for approval UI state and test assertions.

## Render Sender Choices

```ts
const senders = email.emailSendersSchema.parse(
  await fetch("/api/email/senders").then((r) => r.json()),
);
```

The sender schema describes the concrete `From` choices for the current user,
the default sender, and whether the list is restricted by policy.

## Gate An App Behind An Emailed Code

```ts
import { auth, SESSION_COOKIE_NAME } from "@dbx-tools/shared-email";

const { email } = auth.authRequestSchema.parse(await request.json());
const status = auth.authStatusSchema.parse(await (await fetch("/api/email/auth/status")).json());
```

The flow is `POST /request` (email) → a 6-digit code is emailed → `POST /verify`
(email + code) → an HttpOnly session cookie named `SESSION_COOKIE_NAME` is set →
`GET /status` reports whether the caller is authenticated.

`request` ALWAYS reports success. That is deliberate anti-enumeration: the
response never reveals whether an address is allow-listed or was actually sent a
code, so a client cannot use the login form to discover who has access. Treat a
`{ ok: true }` from `request` as "the request was accepted", never as "that
address exists".

`SESSION_COOKIE_NAME` lives here rather than in either server package because
both the in-process gate and the CLI reverse proxy SET it, and browser code
reads it — three places that must agree on one string.

## Modules

- `email` - `emailAttachmentSchema`, `emailMessageSchema`,
  `emailResultSchema`, `emailSendersSchema`, and flat inferred types:
  `EmailAttachment`, `EmailMessage`, `EmailResult`, and `EmailSenders`.
- `auth` - the OTP gate wire format: `authRequestSchema`,
  `authRequestResultSchema`, `authVerifySchema`, `authVerifyResultSchema`,
  `authStatusSchema`, `SESSION_COOKIE_NAME`, and their inferred types.

The schemas intentionally avoid array `.min()` constraints so they can be reused
as model/tool JSON schemas for serving endpoints that reject `minItems`.
