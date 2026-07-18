# @dbx-tools/ui-mastra

React chat UI for the AppKit-Mastra plugin.

Import this package when a Databricks App needs a production-ready chat surface
for [`@dbx-tools/appkit-mastra`](../../node/appkit-mastra): streaming
assistant responses, model selection, Genie progress events, inline charts/data
tables, tool approvals, conversation history, thread management, export, and
MLflow feedback.

Key features:

- Drop-in `MastraChat` component that discovers the plugin client config and
  wires itself to the default agent.
- Headless `useMastraChat()` driver for apps that want the same transport logic
  with custom layout.
- Controlled `ChatView` for hosts that own messages, streaming, model state, and
  route calls themselves.
- `MastraPluginClient` wrapper around `@mastra/client-js` with AppKit-Mastra
  routes for history, threads, model lists, suggestions, feedback, charts, and
  statement data.
- Tool-approval support for suspended Mastra `requireApproval` calls, including
  direct resumed-stream handling.
- Inline embed rendering for `[chart:<id>]` and `[data:<id>]` markers produced by
  the server plugin.
- Conversation sidebar with new, select, rename, delete, active-thread, and
  background-streaming states, plus a per-row cancel for a running thread.
- Concurrent threads: run several conversations at once, switch between them
  while each keeps streaming, and cancel any one independently (per-thread abort
  + routing, no shared client state).
- Mid-turn steering: submit a message while a turn streams to "send now" - it
  interrupts the in-flight run and starts a fresh turn with your message
  immediately.
- Export menu for PDF and Markdown, resolving charts and tables so
  exported conversations remain useful offline.

## Why Not Just AppKit UI?

Use native `@databricks/appkit-ui` when you need its general primitives, Genie
chat component, or Model Serving hooks directly against native AppKit plugins.

Use this package when the server is
[`@dbx-tools/appkit-mastra`](../../node/appkit-mastra) and the UI needs to
understand Mastra-specific behavior:

- `@mastra/client-js` agent streaming plus the plugin's custom history, threads,
  models, suggestions, feedback, chart, and statement routes.
- Suspended `requireApproval` tool calls and resumed approve/deny streams.
- Genie writer events rendered as inline tool progress, not just a terminal
  answer.
- `[chart:<id>]` and `[data:<id>]` assistant markers rendered as ECharts charts
  and sortable tables.
- Concurrent multi-thread streaming, per-thread cancel, and mid-turn steering
  ("send now" interrupts the live run and restarts with your message) - the
  native AppKit chat surface runs one turn at a time and has no steering.
- Conversation export that resolves those embeds into Markdown or PDF.

## Add The Styles

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-mastra/styles.css";
```

The stylesheet imports the shared `@dbx-tools/ui-appkit` foundation and registers
this package's React files with Tailwind. It does not define design tokens; the
chat UI uses AppKit semantic tokens from the host app.

## Render A Drop-In Chat

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

export function App() {
  return (
    <MastraChat
      agentId="analyst"
      showModelPicker
      enableThreads
      enableExport
      enableFeedback
      className="h-dvh"
    />
  );
}
```

`MastraChat` is the quickest client for the AppKit-Mastra plugin. It reads the
plugin's published client config, creates a `MastraPluginClient`, streams turns
through `agent.stream()`, hydrates the latest history page, and renders the
controlled `ChatView`.

Useful options:

- `agentId` selects a registered agent; defaults to the plugin default agent.
- `showModelPicker` fetches `/models` and sends `X-Mastra-Model` overrides.
- `suggestions` overrides Genie starter questions; omit it to auto-fetch
  `/suggestions`, or pass `[]` to hide suggestions.
- `enableThreads` turns on persisted conversation selection and the sidebar.
- `enableExport` adds whole-conversation and per-message export affordances.
- `enableFeedback` enables thumbs/comment controls when the server reports
  MLflow feedback is available and a turn produced a trace id.

## Use The Headless Driver

```tsx
import { ChatView, useMastraChat } from "@dbx-tools/ui-mastra/react";

export function CustomChat() {
  const chat = useMastraChat({
    agentId: "analyst",
    showModelPicker: true,
    enableThreads: true,
  });

  return <ChatView {...chat} className="h-full" />;
}
```

Use `useMastraChat()` when the stock behavior is right but the surrounding layout
belongs to your app. The hook owns streaming, aborts, history paging, thread
selection, model overrides, suggestions, exports, approvals, and feedback state.

## Build A Controlled Chat Surface

```tsx
import { ChatView, type ChatViewProps } from "@dbx-tools/ui-mastra/react";

export function ReviewChat(props: ChatViewProps) {
  return <ChatView {...props} className="h-[640px]" />;
}
```

`ChatView` is presentational. It renders the header, model picker, conversation
sidebar, transcript, tool progress, approval cards, suggestions, export controls,
feedback controls, and composer from props. Use it when your app already has a
transport or needs to combine Mastra messages with another state model.

## Call Plugin Routes Directly

```ts
import {
  MastraPluginClient,
  useMastraClient,
  useMastraDefaultModel,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
} from "@dbx-tools/ui-mastra/react";

const client = new MastraPluginClient(clientConfig);

// Routing (thread + model) is passed per call, so concurrent runs on
// different threads never share state.
const stream = await client.streamAgent({
  agentId: client.defaultAgent,
  messages: [{ role: "user", content: "Hello" }],
  runId,
  threadId: activeThreadId,
  model: "claude sonnet",
  signal: controller.signal,
});

const models = await client.models();
const history = await client.history({ threadId: activeThreadId, page: 0, perPage: 20 });
```

Each conversation thread runs independently: start a turn on one thread, switch
to another and start a second, and both stream concurrently. Cancel one via its
`AbortSignal` (or the driver's `onCancelThread`) without touching the others.

`MastraPluginClient` extends `@mastra/client-js` with the AppKit-Mastra custom
routes. It uses `credentials: "include"` so session cookies travel with streaming
and REST calls. The React hooks wrap common route calls for model catalogues,
suggestions, thread lists, chart fetches, and statement-data fetches.

## Approvals, Embeds, And Feedback

The UI understands the extra events produced by
[`@dbx-tools/appkit-mastra`](../../node/appkit-mastra):

- `tool-call-approval` chunks become inline approval cards and call
  `approve-tool-call` / `decline-tool-call` when the user decides.
- Genie writer events render as tool progress, including thinking text, SQL, row
  counts, result summaries, and chart/data markers.
- `[chart:<id>]` markers long-poll the chart cache and render ECharts inline.
- `[data:<id>]` markers fetch statement rows and render a sortable table with
  column toggles and CSV export.
- MLflow trace headers enable per-message feedback controls when the server
  reports feedback is available.

## Export Conversations

```tsx
<MastraChat enableExport />
```

Exports support Markdown downloads and PDF (rendered through a hidden print iframe, so the browser's Save-as-PDF dialog opens with no popup tab). Chart and data markers are
resolved during export: charts are rendered to inline SVG with ECharts' server
renderer, and data markers become real tables. Expired or missing embeds are
skipped so old transcripts still export cleanly.

## Modules

- `MastraChat` - self-contained drop-in chat component.
- `useMastraChat` - headless driver that returns `ChatView` props.
- `ChatView` - controlled presentational chat shell.
- `MastraPluginClient` - `@mastra/client-js` plus AppKit-Mastra custom routes.
- `useMastraClient`, `useMastraConfig`, `useMastraModels`,
  `useMastraDefaultModel`, `useMastraSuggestions`, `useMastraThreads`,
  `useChartFetch`, `useStatementFetch` - route/config hooks for controlled
  clients.
- `ThreadSidebar` - controlled conversation list.
- `ExportMenu` - shared export format menu.
- Types - `ChatViewProps`, `MastraChatProps`, `UseMastraChatOptions`,
  `ThreadSummary`, `ToolEvent`, `ToolProgress`, `PendingApproval`,
  `FeedbackSubmission`, and related UI contract types.

Server-side routes and event production live in
[`@dbx-tools/appkit-mastra`](../../node/appkit-mastra). Browser-safe route,
marker, feedback, and wire schemas live in
[`@dbx-tools/shared-mastra`](../../shared/mastra).
