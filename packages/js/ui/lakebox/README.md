# @dbx-tools/ui-lakebox

Render Lakebox lifecycle controls, user services, and live machine metrics in
an AppKit React application.

## Render the Lakebox page

```tsx
import { LakeboxIndicator, LakeboxPanel } from "@dbx-tools/ui-lakebox/react";

export function LakeboxPage() {
  return (
    <>
      <header>
        <LakeboxIndicator />
      </header>
      <LakeboxPanel />
    </>
  );
}
```

Import the stylesheet once after Tailwind and your AppKit UI theme:

```css
@import "@dbx-tools/ui-lakebox/styles.css";
```

The panel shows start and stop controls, the current user's terminal, desktop,
image services, bounded logs, and removal confirmation. It streams CPU,
memory, persistent storage, and network metrics while the Lakebox runs.

The indicator fits in a chat header. Its popover has lifecycle controls,
terminal and desktop launchers, and compact metrics.

## Register the backend plugin

The React components require `@dbx-tools/appkit-lakebox` in the same AppKit
application:

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { lakebox } from "@dbx-tools/appkit-lakebox";

await createApp({
  plugins: [server(), lakebase(), lakebox()],
});
```

The backend plugin publishes `basePath` and `routePrefix` through AppKit client
configuration. The UI reads that configuration, derives routes from
`@dbx-tools/shared-lakebox`, and sends same-origin requests. Don't copy plugin
paths into the client.

## Use the browser client directly

Use `LakeboxClient` when you need lifecycle or service actions outside the
provided components:

```tsx
import { useLakeboxClient } from "@dbx-tools/ui-lakebox/react";

export function StartLakeboxButton() {
  const client = useLakeboxClient();
  return (
    <button type="button" onClick={() => void client.start()}>
      Start Lakebox
    </button>
  );
}
```

The client provides status, start, stop, service create, service start and
stop, service removal, bounded logs, current metrics, and an SSE metrics
stream.

## Understand UI behavior

- Components use the current AppKit session. They never accept or store
  Databricks credentials.
- The panel reports when Lakeboxes aren't available in the workspace.
- Opening the indicator starts status and metrics activity. Closing it stops
  the indicator's live metrics stream.
- Machine metrics are sampled only while a client watches them, so the UI
  doesn't keep an idle Lakebox active by polling metrics.
- Start and stop affect the one Lakebox shared by the app. Service controls
  affect only the authenticated user's services.
- Terminal and desktop links use authenticated same-origin proxy routes. The
  browser never connects to the SSH gateway directly.
