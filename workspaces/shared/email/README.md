# @dbx-tools/shared-email

Browser-safe email schemas and inferred types.

Import this package when a UI, Mastra tool schema, server route, or test needs
to validate the same email payloads that
[`@dbx-tools/node-email`](../../node/email) sends.

Key features:

- Shared `EmailMessage` contract for generated email drafts and direct sends.
- Attachment schema that supports inline content, file paths, URLs, encoding,
  and content-type hints.
- Send-result schema for SMTP and outbox responses.
- Sender-options schema for AppKit routes that expose allowed `From` values to
  a browser client.
- Model/tool-friendly schemas that avoid JSON Schema constraints known to cause
  problems with some serving endpoints.

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

The message schema covers recipients, subject, Markdown body, and attachments.
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

## Module

- `email` - `emailAttachmentSchema`, `emailMessageSchema`,
  `emailResultSchema`, `emailSendersSchema`, and flat inferred types:
  `EmailAttachment`, `EmailMessage`, `EmailResult`, and `EmailSenders`.

The schemas intentionally avoid array `.min()` constraints so they can be reused
as model/tool JSON schemas for serving endpoints that reject `minItems`.
