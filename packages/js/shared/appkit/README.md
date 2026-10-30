# @dbx-tools/shared-appkit

Browser-safe schemas, route constants, and client configuration contracts for
dbx-tools AppKit extensions.

## Build a browser debug capture request

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

## Resolve the browser capture endpoint

Use the published client configuration instead of hard-coding an AppKit route.
The route helper normalizes a configured base path and appends the capture
resource path.

```ts
import {
  DebugCaptureClientConfigSchema,
  debugCaptureRoute,
} from "@dbx-tools/shared-appkit/debug";

const config = DebugCaptureClientConfigSchema.parse({
  basePath: "/api/debug-capture",
});
const endpoint = debugCaptureRoute(config.basePath);
```

The resulting endpoint is `/api/debug-capture/captures` for the default AppKit
plugin configuration.
