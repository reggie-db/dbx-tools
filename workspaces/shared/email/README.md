# @dbx-tools/shared-email

The browser-safe wire-format contract for the email add-on: the email a model
drafts and the result of dispatching it, as zod schemas plus inferred types.

Pure - no `node:*` imports - so the server-side sender, a `send_email` agent
tool, and a React approval UI all validate and type against one definition.

```ts
import { email, type EmailMessage } from "@dbx-tools/shared-email";

const message: EmailMessage = email.emailMessageSchema.parse(toolInput);
```

## Module

- `email` - `emailMessageSchema` (tool input), `emailAttachmentSchema`,
  `emailResultSchema` (dispatch result), `emailSendersSchema` (`From` picker
  options) + their inferred types (hoisted flat: `EmailMessage`, `EmailResult`,
  `EmailAttachment`, `EmailSenders`).

Array fields intentionally avoid `.min()` / `.nonempty()`: those emit `minItems`
in the JSON schema, which some Model Serving endpoints reject when the schema is
forwarded as a tool definition.
