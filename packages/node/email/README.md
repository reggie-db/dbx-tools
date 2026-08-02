# @dbx-tools/email

Server-side email runtime, agent tools, and AppKit plugin.

Import this package when an AppKit or Mastra backend needs model-drafted
outbound email with human approval, sender derivation, SMTP dispatch, and a
local outbox mode for development. AppKit ships no first-party email surface,
so this is additive rather than an alternative to a native plugin. Browser-safe
message/result schemas live in
[`@dbx-tools/shared-email`](../../shared/email), and the reusable React Email
presentation lives in
[`@dbx-tools/shared-email-template`](../../shared/email-template).

**Key features:**

- AppKit plugin registration that resolves config, verifies SMTP at boot, and
  mounts a sender-options route.
- Two agent surfaces over one runtime: a Mastra `send_email` tool that suspends
  for human approval, and an AppKit `email.send` tool annotated as a write so a
  host's approval gate fires.
- SMTP delivery for production and HTML outbox delivery for local development
  and tests.
- Sender derivation from the current Databricks user, a fixed `EMAIL_FROM`, or a
  configured domain.
- Deny-by-default sender policy with exact addresses, domains, domain wildcards,
  and a named `unrestricted` escape hatch.
- React Email rendering with responsive components, matching HTML/plain-text
  alternatives, metadata, attachment summaries, and the dbx-tools brand by default.
- Named caps on body length and attachment size, and an `AbortSignal` threaded
  through every send.

## Register The AppKit Plugin

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { plugin as emailPlugin, tool as emailTool } from "@dbx-tools/email";
import { agents, plugin as mastraPlugin } from "@dbx-tools/appkit-mastra";

const support = agents.createAgent({
  instructions: "Draft emails, but wait for approval before sending.",
  tools: () => ({ send_email: emailTool.emailTool() }),
});

await createApp({
  plugins: [
    server(),
    lakebase(),
    emailPlugin.email({
      smtp: { host: "smtp.example.com", user: "apikey", password: process.env.SMTP_KEY },
      domain: "mail.example.com",
    }),
    mastraPlugin.mastra({ agents: support, storage: true }),
  ],
});
```

`plugin.email()` validates config, primes the shared runtime, verifies SMTP when
SMTP mode is active, and mounts a sender-options route for UIs. A failed verify
fails setup, so a bad host or credential shows up in the boot logs rather than on
the first approved send; outbox mode skips the check and logs loudly instead.

`tool.emailTool()` creates an approval-gated Mastra `send_email` tool. Approval
requires Mastra storage, so register `lakebase()` or configure storage explicitly
in the Mastra plugin.

The plugin does not decide how approval is presented. It emits a Mastra tool
suspension and expects the host UI to resume that tool call with an approval or
denial result. [`@dbx-tools/ui-email`](../../ui/email) provides the matching
approval card and compose components.

## Configuration

| Option           | Type                            | Default                                   | Description                                                                      |
| ---------------- | ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `smtp.host`      | `string`                        | `SMTP_HOST`                               | SMTP server hostname. Omit the whole `smtp` block to run in outbox mode.         |
| `smtp.port`      | `number`                        | `SMTP_PORT`, then `587`                   | SMTP server port.                                                                |
| `smtp.secure`    | `boolean`                       | `SMTP_SECURE`, then `port === 465`        | TLS-on-connect socket rather than STARTTLS.                                      |
| `smtp.user`      | `string`                        | `SMTP_USER`                               | SMTP auth username.                                                              |
| `smtp.password`  | `string`                        | `SMTP_PASSWORD`                           | SMTP auth password or API key.                                                   |
| `domain`         | `string`                        | `EMAIL_DOMAIN`                            | Domain the sender is derived on, as `<user-local-part>@<domain>`.                |
| `from`           | `string`                        | `EMAIL_FROM`                              | Fixed `From` address. Skips per-user derivation.                                 |
| `senderPolicy`   | `"allowlist" \| "unrestricted"` | `EMAIL_SENDER_POLICY`, then `"allowlist"` | How the sender is restricted when `allowedSenders` is empty.                     |
| `allowedSenders` | `string \| string[]`            | `EMAIL_ALLOWED_SENDERS`                   | Permitted `From` patterns: exact addresses, `*@domain`, a bare `domain`, or `*`. |
| `outDir`         | `string`                        | `EMAIL_OUTBOX_DIR`, then `<cwd>/tmp`      | Directory the outbox writes HTML previews to.                                    |
| `brand`          | `EmailBrand`                    | dbx-tools brand                           | Colors, font, display name, footer, and optional logo applied to every message.  |

Precedence per field is explicit config, then the environment variable, then the
built-in default.

| Environment variable    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `SMTP_HOST`             | SMTP server hostname.                                         |
| `SMTP_PORT`             | SMTP server port.                                             |
| `SMTP_SECURE`           | Force or disable a TLS-on-connect socket.                     |
| `SMTP_USER`             | SMTP auth username.                                           |
| `SMTP_PASSWORD`         | SMTP auth password or API key.                                |
| `EMAIL_DOMAIN`          | Domain for the derived sender address.                        |
| `EMAIL_FROM`            | Fixed `From` address.                                         |
| `EMAIL_SENDER_POLICY`   | `allowlist` (default) or `unrestricted`.                      |
| `EMAIL_ALLOWED_SENDERS` | Comma- or whitespace-separated `From` allow-list.             |
| `EMAIL_OUTBOX_MODE`     | Opt in to writing messages to disk when SMTP is unconfigured. |
| `EMAIL_OUTBOX_DIR`      | Directory for outbox previews.                                |

The `SMTP_*` names are unprefixed because SMTP is a third-party service, not a
Databricks resource.

## Send Without An Agent

```ts
import { transport } from "@dbx-tools/email";

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
involved. The same resolved runtime is used by the AppKit plugin and both agent
tools, so every path shares one connection pool, one sender policy, and one set
of caps. A third argument accepts an `AbortSignal` when the caller wants to stop
waiting on SMTP.

The plugin export is equivalent and resolves the sender for you when the caller
is a Databricks user:

```ts
const appkit = await createApp({ plugins: [server(), emailPlugin.email()] });
await appkit.email.sendEmail(message, "reports@example.com");
```

## How Sends Reach AppKit's Interceptors

Every send runs through AppKit's interceptor chain (timeout, telemetry, and the
retry / cache posture in `defaults`), including sends from the Mastra tool, which
has no plugin instance in scope. The runtime carries an executor slot for this:
registering the plugin installs its own `Plugin.execute()` there at setup, and
`sendEmail()` routes through whatever is installed.

Nothing else has to be wired up. Two consequences are worth knowing:

- In a plain Mastra app with no AppKit plugin registered, the slot falls back to
  running the send directly, so the tool still works without interceptors.
- Recipient, cap, and sender-policy checks run _before_ the chain, so a rejected
  message keeps its specific status and actionable message. A failure inside the
  chain is re-raised as a stable `ExecutionError`, so an SMTP relay's own wording
  never becomes the caller's or the model's error text.

## Resolve SMTP Or Outbox Mode

```ts
import { config, transport } from "@dbx-tools/email";

const resolved = config.resolveEmailConfig({
  smtp: { host: "smtp.example.com", user: "apikey", password: secret },
  domain: "mail.example.com",
});

const runtime = transport.getEmailRuntime({
  smtp: { host: "smtp.example.com", user: "apikey", password: secret },
  domain: "mail.example.com",
});
```

`resolveEmailConfig()` returns the validated `ResolvedEmailConfig` for
inspection. `getEmailRuntime()` takes the same plugin config, resolves it, and
memoizes the transport process-wide; the plugin primes it at setup, so later
callers pass nothing and get the same instance.

SMTP mode requires host, user, password, and a sender source. Outbox mode writes
HTML files to disk when SMTP credentials are absent and `EMAIL_OUTBOX_MODE=1`.

Use SMTP mode for deployed apps. Use outbox mode for local demos, automated
tests, and development loops where sending real mail would be risky.

## Agent Tools

Two tools expose the same send capability, one per agent runtime. Both are
gated: the Mastra tool suspends for approval, and the AppKit tool is annotated
`{ effect: "write", requiresUserContext: true }` so a host's approval gate fires.
The AppKit tool is deliberately not `autoInheritable`, so an agent reaches it
only by wiring it explicitly.

| Tool         | Runtime | Wiring                                                                   |
| ------------ | ------- | ------------------------------------------------------------------------ |
| `send_email` | Mastra  | `tools: () => ({ send_email: emailTool.emailTool() })`                   |
| `email.send` | AppKit  | `plugins.email.toolkit()` in code, or a `plugin:email` frontmatter entry |

```ts
import { createApp, server } from "@databricks/appkit";
import { agents, createAgent } from "@databricks/appkit/beta";
import { plugin as emailPlugin } from "@dbx-tools/email";

const support = createAgent({
  instructions: "Draft emails, but wait for approval before sending.",
  tools: (plugins) => ({ ...plugins.email.toolkit() }),
});

await createApp({
  plugins: [server(), emailPlugin.email(), agents({ agents: { support } })],
});
```

## AppKit Routes

| Method | Path                 | Response                                                   |
| ------ | -------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/email/senders` | `email.emailSendersSchema` from `@dbx-tools/shared-email`. |

The response includes the concrete sender addresses the current user may choose,
the default sender address, and whether the list was restricted by policy. The
route runs in the on-behalf-of user scope so domain wildcards resolve against the
caller's own local part.

Use this route to populate a `From` dropdown in a compose UI. If no dropdown is
shown, the server can still derive the sender from the active user and config.

## Derive And Restrict Senders

```ts
import { config, sender } from "@dbx-tools/email";

const resolved = config.resolveEmailConfig({ domain: "mail.example.com" });
const from = sender.resolveSenderAddress(resolved, "alice@databricks.com");

sender.assertSenderAllowed(from, resolved.allowedSenders);
```

Sender helpers support exact addresses, domain wildcards, bare domains, and `*`.
`sender.listSenderOptions(resolved, userEmail)` produces the concrete `From`
choices for the current user, which is what the AppKit plugin exposes to clients.

The default `senderPolicy: "allowlist"` is deny-by-default: with no explicit
`allowedSenders`, the effective allow-list is the configured sender source, so a
deployment that only sets `EMAIL_DOMAIN` rejects a `From` on any other domain.
Set `senderPolicy: "unrestricted"` to accept any `From` a caller supplies. The
effective policy is logged at boot.

## Render A React Email

```ts
import { emailHtml, markdown } from "@dbx-tools/email";

const html = await emailHtml.renderEmailHtml({
  subject: "Incident update",
  body: "## Status\nResolved.",
});

const text = await emailHtml.renderEmailText({
  subject: "Incident update",
  body: "## Status\nResolved.",
});

const fragment = await markdown.markdownToHtml("## Status\nResolved.");
```

`renderEmailHtml()` and `renderEmailText()` render the same shared React Email
component tree into the two MIME alternatives used by SMTP. The universal
components live in `@dbx-tools/shared-email-template`, so the browser preview
and delivered message share typography, content styling, and brand behavior.
`markdown.normalizeMarkdown()` remains available for compatibility, while
`markdown.markdownToHtml()` now renders through the shared React Email body.

## Brand The Email

Every message uses the repository's dbx-tools brand by default. Pass a `brand`
to the plugin or renderer only when the consuming application needs its own
identity.

```ts
import { brand, plugin } from "@dbx-tools/email";

// Explicitly select the same brand used by default:
plugin.email({ brand: brand.defaultEmailBrand });

// Or derive from any shared BrandContext:
import { brand as coreBrand } from "@dbx-tools/shared-core";
plugin.email({ brand: brand.emailBrandFromContext(coreBrand.defaultBrandContext) });

// Or hand-build the small email-safe slice:
plugin.email({
  brand: {
    accent: "#FF3621",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    name: "Acme",
    logoUrl: "https://acme.example/logo.svg", // http(s): or data: only
  },
});
```

React Email applies the brand through email-safe inline styles. The browser UI's
`[data-brand]` CSS bridge cannot reach an inbox, so both the delivered document
and browser preview consume the same `EmailBrand` values directly. A `logoUrl`
renders when it is an `http(s):`, `data:`, or `cid:` URL; otherwise the branded
display name becomes the header mark.

## Use The Outbox In Tests

```ts
import { outbox } from "@dbx-tools/email";

const path = await outbox.writeOutboxEmail(message, "bot@example.com", "tmp/email-outbox");
```

Outbox files are HTML previews with metadata in the header, written to
`<dir>/<from>/<timestamp>-<subject-slug>.html`. A fourth argument accepts an
`EmailBrand`. Attachments are listed in the preview, but attachment bytes are not
copied to disk.

## Limits

| Constant                      | Value   | Bounds                                   |
| ----------------------------- | ------- | ---------------------------------------- |
| `MAX_BODY_CHARS`              | 200,000 | Email content length.                    |
| `MAX_ATTACHMENT_BYTES`        | 10 MiB  | One attachment's decoded inline content. |
| `MAX_ATTACHMENTS_TOTAL_BYTES` | 20 MiB  | Combined decoded attachment content.     |
| `MAX_ATTACHMENT_COUNT`        | 20      | Attachments on one message.              |
| `SEND_TIMEOUT_MS`             | 30,000  | One SMTP conversation.                   |
| `VERIFY_TIMEOUT_MS`           | 15,000  | The setup-time SMTP handshake.           |

An oversized payload is rejected with a `ValidationError` before anything is
handed to SMTP. The constants and the plugin's interceptor settings live in the
`defaults` module.

## Modules

- `plugin` - `EmailPlugin`, the `email()` AppKit plugin factory, the sender
  route, and the `email.send` AppKit agent tool.
- `tool` - approval-gated `emailTool()` Mastra tool and the shared
  `SEND_EMAIL_DESCRIPTION`.
- `transport` - shared runtime, `getEmailRuntime()`, `resetEmailRuntime()`,
  `verifyEmailTransport()`, `sendEmail()`, and the executor slot
  (`setEmailExecutor()`, `executeWrite()`) that puts every send on AppKit's
  interceptor chain.
- `config` - SMTP/outbox config types, sender policy, JSON schema, and
  `resolveEmailConfig()`.
- `defaults` - execution settings for the interceptor chain and the payload caps.
- `sender` - sender derivation, allow-list parsing, and sender-option listing.
- `markdown` / `emailHtml` - React Email body, HTML, and plain-text rendering.
- `outbox` - local HTML file writer for development and tests.
- `brand` - `EmailBrand`, `emailBrandFromContext()`, and `defaultEmailBrand`.

Pair this package with [`@dbx-tools/shared-email`](../../shared/email) when a UI
or tool schema needs to validate the same email payload, and with
[`@dbx-tools/shared-email-template`](../../shared/email-template) when another
runtime needs to reuse the presentation components directly.
