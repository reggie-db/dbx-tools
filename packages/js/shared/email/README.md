# @dbx-tools/shared-email

Browser-safe email sending schemas and inferred types.

Use these schemas in UIs, Mastra tools, routes, and tests that exchange email
payloads with [`@dbx-tools/email`](../../node/email).

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

The package also includes send-result and sender-option schemas for routes,
approval UIs, and tests.

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

## Modules

- `email` - `emailAttachmentSchema`, `emailMessageSchema`,
  `emailResultSchema`, `emailSendersSchema`, and flat inferred types:
  `EmailAttachment`, `EmailMessage`, `EmailResult`, and `EmailSenders`.
  The schemas intentionally avoid array `.min()` constraints so they can be reused
  as model/tool JSON schemas for serving endpoints that reject `minItems`.

Passwordless authentication contracts live in
[`@dbx-tools/shared-auth`](../auth).
