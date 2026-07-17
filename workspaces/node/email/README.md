# @dbx-tools/node-email

Server-side email add-on: an SMTP runtime (nodemailer) with a local file
"outbox" fallback, markdown -> branded HTML rendering (`marked` + `juice`
inlining), on-behalf-of sender derivation with an optional allow-list, the
approval-gated `send_email` Mastra tool, and the AppKit `email` plugin.

Browser consumers (e.g. an approval UI) import the pure contract from
[`@dbx-tools/shared-email`](../../shared/email) - this package pulls in
nodemailer + AppKit server APIs and is Node-only.

```ts
import { tool, plugin } from "@dbx-tools/node-email";
import { createAgent } from "@dbx-tools/node-mastra"; // (when available)

// Approval-gated send_email tool, spread into an agent:
const support = createAgent({ tools: () => ({ send_email: tool.emailTool() }) });

// Or the AppKit plugin (registered name `email`):
createApp({ plugins: [plugin.email()] });
```

## Modules

- `config` - `resolveEmailConfig` (SMTP vs. file/outbox mode) + JSON Schema.
- `transport` - the shared runtime + `sendEmail`.
- `markdown` / `email-html` - markdown normalization -> HTML -> inlined layout.
- `sender` - `From` derivation + allow-list policy (`parseAllowedSenders`, ...).
- `outbox` - write a message to disk as HTML (no-SMTP fallback).
- `tool` - the approval-gated `send_email` Mastra tool.
- `plugin` - the AppKit `email` plugin (SMTP verify at setup, `GET /senders`).

SMTP / sender config comes from `SMTP_*` / `EMAIL_*` env vars (or the plugin's
typed config). Set `EMAIL_OUTBOX_MODE=1` to write to disk for local testing.
