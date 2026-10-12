# @dbx-tools/ui-databricks-sandbox

React controls for assigned Databricks Sandboxes and persisted Projects.

## Render the manager

```tsx
import { SshManager } from "@dbx-tools/ui-databricks-sandbox/react";

export function SandboxPage() {
  return <SshManager basePath="/api/databricks-sandbox" />;
}
```

The manager creates, starts, stops, and deletes Sandboxes. It also creates
Projects with optional names, path suffixes, ports, and open paths. Empty fields
use server-generated defaults. Project links open the persisted `openUrl`.

## Render the indicator

```tsx
import { SshIndicator } from "@dbx-tools/ui-databricks-sandbox/react";

export function ChatHeader() {
  return <SshIndicator basePath="/api/databricks-sandbox" />;
}
```

Place the indicator in a chat header or history control slot. Pointer selection
and touch long-press expose the same machine actions.

Both components use the current AppKit session. They never accept Databricks
credentials, SSH keys, or project configuration secrets.
