# @dbx-tools/shared-appkit

Browser-safe schemas, route constants, and client configuration contracts for
dbx-tools AppKit extensions.

## Browser debug capture

`@dbx-tools/appkit` publishes the optional debug-capture plugin configuration,
and `@dbx-tools/ui/react` consumes these contracts to record browser events.
Applications normally enable the route through `createApp({ debug: "auto" })`,
which is active only when `NODE_ENV=development`.

```ts
import {
  DebugCaptureClientConfigSchema,
  DebugCaptureRequestSchema,
  debugCaptureRoute,
} from "@dbx-tools/shared-appkit/debug";
```

Capture requests are bounded and contain scalar diagnostics only. The browser
recorder does not send form values or printable key content.

## Validate debug requests

Use `DebugCaptureRequestSchema` on route handlers or tests that accept browser
debug payloads. The schema keeps the wire contract browser-safe while the node
package owns persistence and any server-side processing.
