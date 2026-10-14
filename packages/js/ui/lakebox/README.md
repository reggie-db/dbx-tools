# @dbx-tools/ui-lakebox

React panel, chat-header indicator, and live metrics for the app Lakebox.

## Render the panel

```tsx
import { LakeboxPanel } from "@dbx-tools/ui-lakebox/react";

export function LakeboxPage() {
  return <LakeboxPanel />;
}
```

The panel shows the Lakebox state with Start and Stop, the current user's
terminal, desktop, and services with open, stop, log, and remove actions, and
live CPU, memory, storage, and network metrics while the Lakebox runs.

## Render the indicator

```tsx
import { LakeboxIndicator } from "@dbx-tools/ui-lakebox/react";

export function ChatHeader() {
  return <LakeboxIndicator />;
}
```

The indicator opens a popover with power control, terminal and desktop
launchers, and compact metrics.

Import the stylesheet once after Tailwind and your AppKit UI theme:

```css
@import "@dbx-tools/ui-lakebox/styles.css";
```

Components use the current AppKit session and read the plugin base path from
its published client config. They never accept Databricks credentials.
