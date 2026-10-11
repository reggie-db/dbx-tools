# @dbx-tools/ui-ssh

Compact React controls for listing, starting, stopping, and opening AppKit SSH machines.

## Render machine and route management

```tsx
import { SshManager } from "@dbx-tools/ui-ssh/react";

export function SshPage() {
  return <SshManager basePath="/api/ssh" defaultRemotePort={3000} />;
}
```

The manager starts and stops existing machines, adds routes with optional path
prefix stripping, lists registered routes, opens them in a new tab, and removes
them.

## Render the machine indicator

```tsx
import { SshIndicator } from "@dbx-tools/ui-ssh/react";

export function ChatHeader() {
  return <SshIndicator basePath="/api/ssh" defaultRemotePort={3000} />;
}
```

The indicator lists existing machines and exposes start, stop, and open
actions. Open creates or reuses a route through the AppKit SSH plugin.

## Place the controls

Render `SshIndicator` in a chat header or history control slot. On pointer
devices, selecting a machine expands its actions. On touch devices, a long
press expands the same controls without triggering the synthetic click that
follows the press.

The component uses the current AppKit session and does not accept credentials
or private SSH material.
