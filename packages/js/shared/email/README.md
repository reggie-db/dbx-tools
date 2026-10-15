# @dbx-tools/shared-email

Validate browser, route, and agent-tool payloads for `@dbx-tools/email` without
importing Node-only code.

## Validate a drafted message

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
Attachments carry inline string content, an optional encoding, and an optional
content type. The schema doesn't accept a local path or URL. Read external
content in trusted server code, then pass the resulting string through
`content`.

The package also includes send-result and sender-option schemas for routes,
approval UIs, and tests.

## Validate send results

```ts
import { email } from "@dbx-tools/shared-email";

export function parseEmailResult(value: unknown) {
  return email.emailResultSchema.parse(value);
}

const result = parseEmailResult({
  sent: true,
  recipient: "alice@example.com",
  from: "reports@example.com",
  messageId: "smtp-message-id",
});
```

`emailResultSchema` is the shared shape for SMTP sends and outbox writes. Use it
for approval UI state and test assertions.

## Load sender choices

```ts
import { email } from "@dbx-tools/shared-email";

const senders = email.emailSendersSchema.parse(
  await fetch("/api/email/senders").then((response) => response.json()),
);
```

The sender schema describes the concrete `From` choices for the current user,
the default sender, and whether the list is restricted by policy.

## Understand schema and transport limits

- `emailAttachmentSchema` accepts `filename`, inline `content`, `encoding`, and
  `contentType`. It doesn't read files, fetch URLs, or validate whether an
  encoding matches the content.
- The schemas don't add array `minItems` constraints because some Model Serving
  endpoints reject that JSON Schema keyword. The Node sending layer still
  requires at least one recipient.
- The Node sending layer limits a message to 20 attachments, 10 MiB per decoded
  attachment, 20 MiB across attachments, and 200,000 body characters.
- Outbox mode lists attachment filenames in the rendered preview but doesn't
  write attachment payloads as separate files.
- Sender policy, SMTP delivery, approval, and outbox persistence belong to
  [@dbx-tools/email](../../node/email/README.md).

Passwordless authentication contracts live in
[@dbx-tools/shared-auth](../auth/README.md).
