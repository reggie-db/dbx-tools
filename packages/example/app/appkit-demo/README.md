# Run the demo React client

This package renders the browser half of the dbx-tools demo. It keeps a Mastra
assistant mounted across route changes and provides focused pages for unified
agent/Genie chat, Lakebox, AI Search, the Postgres message bus, and branding.
Desktop layouts also include a hideable guide pane with use cases and links to
the matching documentation sections.

```tsx
import { MastraAssistant } from "@dbx-tools/ui-mastra/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Chat from "./pages/Chat";
import Lakebox from "./pages/Lakebox";

export function App() {
  return (
    <MastraAssistant mode="overlay" side="right" chat={{ showModelPicker: true }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/lakebox" element={<Lakebox />} />
        </Routes>
      </BrowserRouter>
    </MastraAssistant>
  );
}
```

The complete route shell is in [src/App.tsx](src/App.tsx).

## Run the client with AppKit

Run the client through the repository demo task:

```bash
bun install
bun run demo -- -d
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). AppKit's Vite middleware provides hot module
replacement on the AppKit server port. Don't open a separate client
development port for this workflow.

Remove `-d` when server or workspace package changes must restart the AppKit
process:

```bash
bun run demo
```

For full environment and authentication setup, see the
[demo README](../../README.md).

## Use the demo pages

The client has the following pages:

- `Chat.tsx` renders `MastraChat` with model selection, export, threads, and a
  history-area control that switches between the tool-using support agent and
  direct Genie conversations.
- `Lakebox.tsx` renders the current user's Lakebox lifecycle, services, and
  metrics.
- `Search.tsx` uses one component surface for Databricks AI Search or the
  Lakebase full-text provider selected by the server.
- `Bus.tsx` publishes and receives live Postgres topic-bus messages.
- `Brand.tsx` updates the active application brand and email previews.

`MastraAssistant` remains mounted while React Router changes pages. This keeps
the assistant thread and streaming state alive. `AssistantRouteContext` sends
the active route to the server as typed request context.

## Build the production client

Compile the client from the repository root:

```bash
bun run --filter '@dbx-tools/demo-appkit-app' compile
```

The build writes static assets to `dist/`. The demo deployment stages this
directory as `client-dist/`, and the AppKit server serves it from the same
origin as the API.

The client imports AppKit UI, dbx-tools feature styles, and Tailwind in
[src/index.css](src/index.css). Keep React imports resolved to the
application's copy so source-linked UI packages don't create another React
runtime.

## Understand client limits

- The client doesn't hold Databricks credentials. AppKit sessions and the
  server-published plugin configuration provide browser access.
- Genie-only chat requires an on-behalf-of token from the Databricks Apps front
  door.
- Topic-bus delivery is live. Opening a page doesn't replay messages published
  before its event stream connected.
- Lakebox controls require the `@dbx-tools/appkit-lakebox` backend plugin and an
  authenticated user identity.
