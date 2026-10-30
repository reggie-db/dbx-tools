# @dbx-tools/ui-mastra

Add a React chat surface to
[@dbx-tools/appkit-mastra](../../node/appkit-mastra). The package supports
streaming, model selection, AI/BI Genie progress, charts, tables, approvals,
history, threads, export, and MLflow feedback.

## Quick start

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";
import "@dbx-tools/ui-mastra/styles.css";

export function Assistant() {
  return <MastraChat showModelPicker enableExport />;
}
```

The stylesheet imports the shared [@dbx-tools/ui](../appkit) foundation. The
host application must also load Databricks AppKit UI styles.

Package contents:

- Drop-in `MastraChat` component that reads the plugin client config and
  wires itself to the default agent.
- Reload recovery for agent-backed background turns: active run metadata is
  persisted per agent and thread, the cached stream reconnects after a page
  reload, and the final persisted history is refreshed when recovery completes.
- Headless `useMastraChat()` driver for apps that want the same transport logic
  with custom layout.
- Persistent `MastraAssistant` application shell with a floating launcher,
  dock/overlay modes, every edge, optional resizing, external controls, and
  route-stable chat state.
- Controlled `ChatView` for hosts that own messages, streaming, model state, and
  route calls themselves.
- `MastraPluginClient` combines Mastra's official AI SDK chat route, native
  memory APIs, and AppKit-Mastra model, suggestion, feedback, chart, and
  statement routes.
- Tool-approval support for suspended Mastra `requireApproval` calls, including
  resumed-stream handling. An email-shaped input (the `send_email` tool)
  renders as a formatted To / Cc / Subject / Markdown-body preview rather than
  raw JSON.
- Complete native tool input/results retained behind expandable,
  syntax-highlighted JSON Request and Response rows in each tool pill.
- Typed per-turn application context through Mastra's native `RequestContext`
  and server-side `requestContextSchema`.
- Inline embed rendering for `[chart:<id>]` and `[data:<id>]` markers produced by
  the server plugin.
- Conversation sidebar with new, select, rename, delete, active-thread, and
  background-streaming states, plus a per-row cancel for a running thread.
- Placeable conversation UI: dock the list left or right, switch to an
  editor-style tab strip across the top, turn it off, or let `auto` pick between
  a side panel and tabs from the chat's own width.
- Concurrent threads: run several conversations at once, switch between them
  while each keeps streaming, and cancel any one independently. Abort routing
  is per thread, with no shared client state.
- Mid-turn steering queue: messages submitted while a turn streams stack up as
  pending steers. They drain oldest-first when the turn ends. Each queued item
  can be sent now (interrupting the current turn), removed, or dragged to
  reorder the queue.
- Export menu for PDF and Markdown, resolving charts and tables so
  exported conversations remain useful offline.

## Choose a UI package

Use native `@databricks/appkit-ui` for its general primitives, AI/BI Genie chat,
or Model Serving hooks with native AppKit plugins.

Use this package when the server is
[@dbx-tools/appkit-mastra](../../node/appkit-mastra) and the UI needs to
understand Mastra-specific behavior:

- Mastra's official AI SDK chat stream, native resource-scoped memory APIs, and
  the plugin's model, suggestion, feedback, chart, and statement routes.
- Suspended `requireApproval` tool calls resumed through native `resumeData`.
- Genie writer events rendered as inline tool progress rather than only a
  terminal answer.
- `[chart:<id>]` and `[data:<id>]` assistant markers rendered as ECharts charts
  and sortable tables.
- Concurrent multi-thread streaming, per-thread cancel, and a mid-turn steering
  queue. Submit while running to enqueue, drain oldest-first, or send any item
  immediately to interrupt. The native AppKit chat surface runs one turn at a time and
  has no steering.
- Conversation export that resolves those embeds into Markdown or PDF.

Import the AppKit UI stylesheet before this package's stylesheet. Mount the chat
inside the application's authentication boundary. Agent chat can use either
user identity or service-principal identity according to the server plugin's
configuration. Direct Genie chat requires the signed-in user's on-behalf-of
(OBO) context.

`MastraChat` reads the `mastra` plugin's published `clientConfig()` payload
through AppKit. The payload supplies the mount path, default agent, registered
agents, feedback availability, background-turn support, and chat identity
behavior. Don't hard-code plugin routes in browser code.

Use [@dbx-tools/ui](../appkit) for common AppKit, authentication, email, and
search components.

## Configure styles

```css
@import "@databricks/appkit-ui/styles.css";
@import "@dbx-tools/ui-mastra/styles.css";
```

The stylesheet imports the shared `@dbx-tools/ui` foundation and registers
this package's React files with Tailwind. It does not define design tokens. The
chat UI uses AppKit semantic tokens from the host app.

## Add a persistent assistant

Mount `MastraAssistant` inside the app's existing authentication gate and above
the route outlet. Closing the panel hides its presentation without unmounting
the chat driver, so drafts, threads, and active streams survive page navigation.

```tsx
import { MastraAssistant, useMastraAssistant } from "@dbx-tools/ui-mastra/react";

const AskAboutStore = ({ storeId }: { storeId: string }) => {
  const assistant = useMastraAssistant<{ storeId: string; route: string }>();
  return (
    <button onClick={() => assistant.open({ storeId, route: window.location.pathname })}>
      Ask assistant
    </button>
  );
};

export function App() {
  return (
    <MastraAssistant
      mode="overlay"
      side="right"
      resizable={{ defaultSize: 480, minSize: 360, storageKey: "assistant-size" }}
      title="Workflow assistant"
      launcher={{ position: "bottom-right", label: "Open assistant" }}
      chat={{ showModelPicker: true, enableExport: true, threadPlacement: "top" }}
    >
      <RouterAndAuthenticatedApplication />
    </MastraAssistant>
  );
}
```

`mode="dock"` reflows the child application. `mode="overlay"` overlaps it.
`side` accepts `top`, `right`, `bottom`, or `left`. Set `resizable={false}` to
lock size, `launcher={false}` when every launch comes from
`useMastraAssistant()`, `header={false}` to place New, History, and Close beside
the conversation pills. With the header enabled those controls move into it and
the conversation pills remain on their own second row. Replace `icon`, `closeIcon`,
`newConversationIcon`, `historyIcon`, and `launcher.icon`. Below
`mobileBreakpoint` the panel becomes a focus-contained modal overlay with Escape
dismissal while the covered application is inert. A `storageKey` retains
horizontal and vertical sizes independently.

`MastraAssistant` remains mounted when closed, which preserves drafts, scroll
state, active streams, and independent horizontal and vertical sizes.

## Render a drop-in chat

```tsx
import { MastraChat } from "@dbx-tools/ui-mastra/react";

export function App() {
  return (
    <MastraChat
      agentId="analyst"
      showModelPicker
      threadPlacement="auto"
      enableExport
      className="h-dvh"
    />
  );
}
```

`MastraChat` provides the bundled client for the AppKit-Mastra plugin. It reads the
plugin's published client config, creates a `MastraPluginClient`, streams turns
through Mastra's official AI SDK chat route, hydrates native memory, and renders
the controlled `ChatView`. When Mastra returns persisted `messages` without a
precomputed `uiMessages` projection, history hydration uses Mastra's native
`convertMessages(...).to("AIV5.UI")` conversion.

Configure the client with these options:

- `agentId` selects a registered agent and defaults to the plugin default agent.
- `genieSpace` selects a configured Genie alias and bypasses the agent.
- `showModelPicker` fetches `/models` and sends `X-Mastra-Model` overrides.
- `onModelUsage` receives each completed turn's resolved endpoint, cumulative
  tokens, Smart Router observation when applicable, and estimated USD cost when
  the model catalogue publishes a blended rate.
- `composerActions` places host-owned per-turn controls beside the model
  selector without replacing the built-in composer.
- `modelSelectorActions` places host-owned controls inside the model menu after
  the endpoint choices. Supply it only when the active agent supports that
  option, such as a Genie transport toggle.
- `composerLeadingActions` places attachment or app actions on the left side of
  the fixed composer footer. The textarea grows above it to a cap, then scrolls.
  Model and Send/Stop stay pinned bottom-right.
- `suggestions` overrides Genie starter questions. Omit it to auto-fetch
  `/suggestions`, or pass `[]` to hide suggestions.
- `threadPlacement` chooses where conversation management renders, or turns it
  off. See [Place the conversation list](#place-the-conversation-list).
- `enableThreads: false` also sets
  `threadPlacement: "disabled"`.
- `threadId` and `onThreadIdChange` let a host bind the active conversation to
  URL state or another external selector. Unknown external IDs are replaced by
  a new thread and reported with the `missing` reason.
- `enableExport` adds whole-conversation and per-message export affordances.
- Feedback defaults to auto: thumbs, dislike, and comment controls appear when
  the server reports MLflow feedback is available and a turn produced a trace
  id. Set `enableFeedback={false}` to hide them. Viewers with `CAN_MANAGE` on
  the experiment also get an experiment debug link at the end of the action row.

Post-turn follow-ups follow the policy published by AppKit-Mastra. Native Genie
questions and persisted `data-follow-up-suggestions` parts use the same
near-duplicate filter and source round-robin. After a turn settles, the latest
questions render through `SuggestionPills` at the end of the scrollable
transcript. They disappear when the next user turn starts and remain available
after history hydration because generated suggestions are persisted on the
assistant message.

## Use direct Genie chat

Use `genieSpace` when the application needs the same chat shell without a
supervisor agent:

```tsx
<MastraChat genieSpace="sales" threadPlacement="auto" enableExport />
```

Set `genieVisualization="image"` to show Genie's original rendered PNG in the
Chart tab while keeping the linked query result in the Table tab:

```tsx
<MastraChat genieSpace="sales" genieVisualization="image" />
```

The alias comes from the server plugin's `genieSpaces`. The client still uses
AI SDK `UIMessage` streams and the same `ChatView`. Genie conversations replace
Mastra threads and Genie messages remain the visible history. When Mastra
memory is configured, the server injects resource-scoped semantic recall and
saves completed direct turns without replacing Genie's conversation ownership.

Turns and history require the Genie Agent API and never fall back to classic
Genie message polling. The sidebar filters the Genie conversation listing to
Agent Mode conversations. Genie decides whether a query should be visualized.
Visualization attachments render through AppKit UI's native
`GenieQueryVisualization`, with Chart and Table tabs, unless image mode is
selected. This does not invoke a supervisor or the Mastra Model Serving chart
planner. Queries without a
visualization attachment render through the existing sortable data table.

Direct mode requires the signed-in user's Databricks OBO context. It supports
new/select/delete conversations, history, suggestions, thoughts, exports, and
stream cancellation. It does not support conversation rename, file
attachments, MLflow feedback, approvals, background turns, or stream
reconnection. The newest 100 conversations are listed and each selected
conversation loads as one history page.

## Place the conversation list

Conversation management is on by default. Where it lives is one option:

```tsx
<MastraChat threadPlacement="top" />
```

| `threadPlacement` | Layout                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| `auto` (default)  | `left` while the chat is wide, `top` once it is too narrow for a panel     |
| `left` / `right`  | List docked to that edge, collapsing to an overlay drawer on a narrow chat |
| `top`             | Tab strip of open conversations, with a history menu for the rest          |
| `disabled`        | No thread UI. Uses a single thread on the session cookie                   |

The docked placements render the sidebar as an inline column with a persisted
show/hide toggle. Below 768px of chat width the panel becomes an overlay drawer
on the same edge, so the transcript never loses room. The drawer is
session-scoped and starts closed, and closes itself after a selection.

The composer accepts images from the upload action, drag and drop, or clipboard
paste. Oversized images use the same client-side resize path before submission.

The `top` placement is the editor-tab model: each open conversation is a tab with
its title, a spinner while it streams in the background, and a close affordance
that only takes the tab off the strip (the conversation stays in history). A `+`
starts a fresh conversation. The history button opens the full sidebar as a
menu, so rename, delete, and cancel still work on conversations that aren't on
the tab strip. Closing the active tab moves to a neighboring one, or
starts a fresh conversation when it was the last tab open. The open set is
session state. The strip reseeds from the most recent conversations on the next
load.

For agent-backed chat, selecting a conversation fetches only the newest 20
native memory messages. Scrolling upward requests the next page and prepends it
without moving the reader's viewport. Agent turns still send only the new user
message. Mastra loads the remembered transcript server-side. Direct Genie mode
loads the selected Genie conversation in one page.

`auto` measures the chat's own element rather than the viewport, so a chat
embedded in a split view or side panel switches to tabs on the space it actually
has instead of waiting for the window to shrink.

## Use the headless driver

```tsx
import { ChatView, useMastraChat } from "@dbx-tools/ui-mastra/react";

export function CustomChat() {
  const chat = useMastraChat({
    agentId: "analyst",
    showModelPicker: true,
    threadPlacement: "left",
  });

  return <ChatView {...chat} className="h-full" />;
}
```

Use `useMastraChat()` when you want package transport behavior with your own
layout. The hook owns streaming, aborts, history paging, thread
selection, model overrides, suggestions, exports, approvals, and feedback state.

## Pass typed application context

`requestContext` accepts a typed plain record, Mastra `RequestContext<T>`, or a
per-turn resolver. The driver snapshots it when a message is submitted and
keeps that snapshot with queued steers, regeneration, and approval continuation.

```tsx
import { RequestContext } from "@mastra/client-js";

type StoreContext = { storeId: string; route: string };

const chat = useMastraChat<StoreContext>({
  requestContext: () =>
    new RequestContext<StoreContext>([
      ["storeId", selectedStore.id],
      ["route", location.pathname],
    ]),
});
```

On the server, declare the same contract with Mastra's native
`requestContextSchema` on `createAgent<StoreContext>()`. Application context
cannot override the authenticated memory resource, thread, user, scopes, model,
or trace fields stamped by AppKit-Mastra. Direct Genie chat forwards the same
native context as reference data for its one Agent Mode user message.

## Build a controlled chat surface

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
Set `showComposer={false}` when a parent surface owns one shared input, such as a
side-by-side model comparison.

`MastraChat` shows a spinner in the model control while its live default model
is being resolved. The picker groups endpoints into
model-family submenus. Its compact first popup shows only the current
model, host-owned actions such as Genie Agent Mode, and a reasoning slider when
the selected endpoint supports it. The current model opens the family picker,
so the long endpoint catalog stays out of the primary control popup. Family
and model menus use the same compact utility type as the composer actions,
omit repeated headers, and omit the already-selected model. The model menu puts
`Default (<resolved model>)` first, keeps `Other` last, and makes a one-model
family directly selectable instead of opening another submenu.

## Call plugin routes directly

```ts
import type { MastraClientConfig } from "@dbx-tools/shared-mastra";
import { MastraPluginClient } from "@dbx-tools/ui-mastra/react";

export async function listChatModels(clientConfig: MastraClientConfig) {
  const client = new MastraPluginClient(clientConfig);
  return client.models();
}
```

Each conversation thread runs independently: start a turn on one thread, switch
to another and start a second, and both stream concurrently. Cancel one using its
`AbortSignal` (or the driver's `onCancelThread`) without touching the others.

`MastraPluginClient` extends `@mastra/client-js` with the official AI SDK
`chatRoute` transport and AppKit-Mastra additions. It uses
`credentials: "include"` so session cookies travel with streaming and REST
calls. The React hooks wrap native memory plus model catalogs, suggestions,
chart fetches, and statement-data fetches. Use `useMastraClient()` to access the
configured client inside React. `useMastraModels()`, `useMastraDefaultModel()`,
`useMastraSuggestions()`, and `useMastraThreads()` expose route-specific state.

## Handle approvals, embeds, and feedback

The UI understands the extra events produced by
[@dbx-tools/appkit-mastra](../../node/appkit-mastra):

- Approval chunks become inline approval cards and continue the official chat
  route with Mastra's native `{ approved, reason? }` resume data.
- Native tool-call and tool-result payloads remain complete. Expanding a tool
  row reveals default-closed Request and Response viewers. Large values scroll
  without string or collection truncation.
- Genie `thinking` events stream into the assistant's collapsed Thoughts
  panel. Intermediate answer attachments and query-result tables stay on tool
  progress, not in Thoughts. Other writer events remain attached to tool
  progress, including SQL, row counts, result summaries, and chart/data
  markers.
- `[chart:<id>]` markers long-poll the chart cache and render ECharts inline.
- `[data:<id>]` markers fetch statement rows and render a sortable table with
  column toggles and CSV export.
- `[visualization:<id>]` markers fetch the same statement under OBO identity and
  render AppKit UI's native Genie Chart/Table component.
- MLflow trace headers enable per-message feedback controls when the server
  reports feedback is available.

## Configure chart themes

ECharts draws to a canvas and doesn't inherit CSS colors from its frame. The
server planner provides the series palette and font stack. The browser resolves
axis, grid, title, legend, and tooltip colors from AppKit semantic tokens at
render time.

- Theme tokens are read from the chart element, so a theme scoped to a chat
  subtree takes precedence over the document theme. Charts update when the
  document's `.dark` or `.light` class changes or when the operating-system
  color preference changes.
- AppKit darkens its tokens under `@media (prefers-color-scheme: dark)` for any
  `:root` that is not explicitly `.light`. If your host renders its own light
  chrome, pin `.light` (or `.dark`) on `:root` rather than leaving AppKit on the
  operating-system preference.

PDF export uses a light chart theme on a white print document.

## Export conversations

```tsx
<MastraChat enableExport />
```

Exports support Markdown downloads and PDF (rendered through a hidden print iframe, so the browser's Save-as-PDF dialog opens with no popup tab). Chart and data markers are
resolved during export: charts are rendered to inline SVG with ECharts' server
renderer, and data markers become real tables. Expired or missing embeds are
skipped so old transcripts still export cleanly.

## Copy and download content

Copy and download controls appear in message bubbles, code blocks, conversation
exports, and the data-grid CSV menu.

Copying works on hosts served over plain HTTP. An insecure context has no
Clipboard API, so a bare `navigator.clipboard.writeText` silently does nothing on
a local or intranet deployment. The package falls back to a hidden
`<textarea>` plus `document.execCommand("copy")` and reports whether the copy
actually succeeded. Downloads revoke their object URL after the temporary anchor
fires, so a long session does not accumulate blobs.

## Package exports

- `MastraChat`: self-contained drop-in chat component.
- `MastraAssistant` / `useMastraAssistant`: persistent application shell and
  external open/close/context controller.
- `useMastraChat`: headless driver that returns `ChatView` props.
- `ChatView`: controlled presentational chat shell.
- `MastraPluginClient`: native `@mastra/client-js` memory/agent APIs plus
  AppKit-Mastra model, suggestion, feedback, and embed routes.
- `useMastraClient`, `useMastraConfig`, `useMastraModels`,
  `useMastraDefaultModel`, `useMastraSuggestions`, `useMastraThreads`,
  `useChartFetch`, `useStatementFetch`: route/config hooks for controlled
  clients.
- `ThreadSidebar`: controlled conversation list, dockable to either edge.
- `ThreadTabs` / `ThreadActions`: conversation pills plus reusable New/History
  controls for the top strip or persistent assistant header.
- `ExportMenu`: shared export format menu.
- Types: `ChatViewProps`, `MastraChatProps`, `UseMastraChatOptions`,
  `MastraAssistantProps`, `MastraRequestContextInput`, `ThreadPlacement`,
  `ThreadSummary`, `ToolEvent`, `ToolProgress`, `PendingApproval`,
  `FeedbackSubmission`, and related UI contract types.

Server-side routes and event production live in
[@dbx-tools/appkit-mastra](../../node/appkit-mastra). Browser-safe route,
marker, feedback, and wire schemas live in
[@dbx-tools/shared-mastra](../../shared/mastra).
