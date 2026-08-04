// Public surface of @dbx-tools/ui-mastra/react.
//
// - `MastraChat` / `useMastraChat`: the self-contained drop-in (and its
//   headless driver) that wire themselves from the Mastra plugin config.
// - `ChatView`: the controlled, presentational shell for callers that
//   own message state and transport themselves.
// - The Mastra plugin client + hooks (model catalogue, history paging,
//   suggestions, embed fetches) the controlled path needs.
// - `dedupeSuggestions`: the dedupe + cap `MastraChat` applies to
//   Genie-sourced starter questions, so another surface offering the same
//   prompts (e.g. a Teams card chat) presents an identical list.
//
// Internal building blocks (bubbles, tool pills, markdown, data grid,
// embed slots) are intentionally not re-exported.

export {
  MastraPluginClient,
  useChartFetch,
  useMastraClient,
  useMastraConfig,
  useMastraDefaultModel,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
  useStatementFetch,
} from "../support/mastra-client.ts";
export type { ByIdFetchState } from "../support/mastra-client.ts";
export { ChatView } from "./chat-view.tsx";
export { ExportMenu } from "./export-menu.tsx";
export { dedupeSuggestions } from "./suggestions.ts";
export { MastraChat, useMastraChat } from "./mastra-chat.tsx";
export type { MastraChatProps, UseMastraChatOptions } from "./mastra-chat.tsx";
export { ThreadSidebar } from "./thread-sidebar.tsx";
export type { ThreadSidebarProps } from "./thread-sidebar.tsx";
export { ThreadTabs } from "./thread-tabs.tsx";
export type { ThreadTabsProps } from "./thread-tabs.tsx";
export type {
  ApprovalDecision,
  ChatModelOption,
  ChatStatus,
  ChatViewProps,
  ExportFormat,
  FeedbackSubmission,
  FeedbackValue,
  MessageFeedback,
  PendingApproval,
  ThreadPlacement,
  ThreadSummary,
  ToolEvent,
  ToolProgress,
} from "./types.ts";
