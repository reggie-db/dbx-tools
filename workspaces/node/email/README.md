# @dbx-tools/node-email

Server-side email runtime, Mastra tool, and AppKit plugin.

Import this package when an AppKit or Mastra backend needs model-drafted
outbound email with human approval, sender derivation, SMTP dispatch, and a
local outbox mode for development. Browser-safe message/result schemas live in
[`@dbx-tools/shared-email`](../../shared/email).

Key features:

- AppKit plugin registration for email runtime setup and sender-option routes.
- A Mastra `send_email` tool that suspends for human approval before delivery.
- SMTP delivery for production and HTML outbox delivery for local development
  and tests.
- Sender derivation from the current Databricks user, a fixed `EMAIL_FROM`, or a
  configured domain.
- Sender allow-list enforcement with exact addresses, domains, domain
  wildcards, and a final `*` escape hatch.
- Markdown-to-HTML rendering with a small email layout, inline styles, metadata,
  and attachment summaries.

## Register The AppKit Plugin

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { plugin as emailPlugin, tool as emailTool } from "@dbx-tools/node-email";
import { agents, plugin as mastraPlugin } from "@dbx-tools/node-appkit-mastra";

const support = agents.createAgent({
  instructions: "Draft emails, but wait for approval before sending.",
  tools: () => ({ send_email: emailTool.emailTool() }),
});

await createApp({
  plugins: [
    server(),
    lakebase(),
    emailPlugin.email(),
    mastraPlugin.mastra({ agents: support, storage: true }),
  ],
});
```

`plugin.email()` validates config, primes the shared runtime, verifies SMTP when
SMTP mode is active, and mounts a sender-options route for UIs. `tool.emailTool()`
creates an approval-gated Mastra `send_email` tool. Approval requires Mastra
storage, so register `lakebase()` or configure storage explicitly in the Mastra
plugin.

The plugin does not decide how approval is presented. It emits a Mastra tool
suspension and expects the host UI to resume that tool call with an approval or
denial result. [`@dbx-tools/ui-email`](../../ui/email) provides the matching
approval card and compose components.

## Send Without An Agent

```ts
import { transport } from "@dbx-tools/node-email";

const result = await transport.sendEmail(
  {
    to: ["alice@example.com"],
    cc: ["team@example.com"],
    subject: "Daily report",
    body: "# Report\nEverything completed.",
    attachments: [{ filename: "report.csv", content: "a,b\n1,2\n" }],
  },
  "reports@example.com",
);
```

Use direct sends for operational mail, tests, or admin flows where a model is not
involved. The same resolved runtime is used by the AppKit plugin and tool.

## Resolve SMTP Or Outbox Mode

```ts
import { config, transport } from "@dbx-tools/node-email";

const resolved = config.resolveEmailConfig({
  smtp: { host: "smtp.example.com", user: "apikey", password: secret },
  domain: "mail.example.com",
});

const runtime = transport.getEmailRuntime(resolved);
```

Resolution order is explicit config first, then env vars:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`;
- `EMAIL_DOMAIN` or `EMAIL_FROM`;
- `EMAIL_OUTBOX_MODE`, `EMAIL_OUTBOX_DIR`;
- `EMAIL_ALLOWED_SENDERS`.

SMTP mode requires host, user, password, and a sender source. Outbox mode writes
HTML files to disk when SMTP credentials are absent and `EMAIL_OUTBOX_MODE=1`.

Use SMTP mode for deployed apps. Use outbox mode for local demos, automated
tests, and development loops where sending real mail would be risky.

## AppKit Routes

The plugin exposes a sender-options route for browser clients. The response
matches `email.emailSendersSchema` from
[`@dbx-tools/shared-email`](../../shared/email) and includes:

- the concrete sender addresses the current user may choose;
- the default sender address;
- whether the list was restricted by policy.

Use this route to populate a `From` dropdown in a compose UI. If no dropdown is
shown, the server can still derive the sender from the active user and config.

## Derive And Restrict Senders

```ts
import { sender } from "@dbx-tools/node-email";

const from = sender.resolveSenderAddress({
  userEmail: "alice@databricks.com",
  domain: "mail.example.com",
});

sender.assertSenderAllowed(from, ["*@mail.example.com", "alerts@example.com"]);
```

Sender helpers support exact addresses, domain wildcards, bare domains, and `*`.
`sender.listSenderOptions()` produces the concrete `From` choices for the
current user, which is what the AppKit plugin exposes to clients.

## Render Markdown Email

```ts
import { emailHtml, markdown } from "@dbx-tools/node-email";

const html = emailHtml.renderEmailHtml({
  subject: "Incident update",
  body: markdown.markdownToHtml("## Status\nResolved."),
});
```

`markdown.normalizeMarkdown()` trims common indentation and fenced-text noise.
`markdown.markdownToHtml()` renders Markdown. `emailHtml.renderEmailHtml()` wraps
the rendered body in the package layout and inlines CSS for mail clients.

## Use The Outbox In Tests

```ts
import { outbox } from "@dbx-tools/node-email";

await outbox.writeOutboxEmail({
  dir: "tmp/email-outbox",
  message,
  from: "bot@example.com",
});
```

Outbox files are HTML previews with metadata in the header. Attachments are
listed in the preview, but attachment bytes are not copied to disk.

## Modules

- `plugin` - `EmailPlugin`, `email()` AppKit plugin factory, and sender route.
- `tool` - approval-gated `emailTool()` Mastra tool.
- `transport` - shared runtime, `getEmailRuntime()`, `resetEmailRuntime()`, and
  `sendEmail()`.
- `config` - SMTP/outbox config types, JSON schema, and `resolveEmailConfig()`.
- `sender` - sender derivation, allow-list parsing, and sender-option listing.
- `markdown` / `emailHtml` - Markdown normalization/rendering and HTML layout.
- `outbox` - local HTML file writer for development and tests.

Pair this package with [`@dbx-tools/shared-email`](../../shared/email) when a UI
or tool schema needs to validate the same email payload.
