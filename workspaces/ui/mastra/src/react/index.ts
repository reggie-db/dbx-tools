// Public surface of @dbx-tools/ui-mastra/react.
//
// - `MastraChat` / `useMastraChat`: the self-contained drop-in (and its
//   headless driver) that wire themselves from the Mastra plugin config.
// - `ChatView`: the controlled, presentational shell for callers that
//   own message state and transport themselves.
// - The Mastra plugin client + hooks (model catalogue, history paging,
//   suggestions, embed fetches) the controlled path needs.
//
// Internal building blocks (bubbles, tool pills, markdown, data grid,
// embed slots, suggestions) are intentionally not re-exported.

export {
  MastraPluginClient,
  useChartFetch,
  useMastraClient,
  useMastraConfig,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
  useStatementFetch,
} from "../support/mastra-client";
export type { ByIdFetchState } from "../support/mastra-client";
export { ChatView } from "./chat-view";
export { ExportMenu } from "./export-menu";
export { MastraChat, useMastraChat } from "./mastra-chat";
export type { MastraChatProps, UseMastraChatOptions } from "./mastra-chat";
export { ThreadSidebar } from "./thread-sidebar";
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
  ThreadSummary,
  ToolEvent,
  ToolProgress,
} from "./types";
