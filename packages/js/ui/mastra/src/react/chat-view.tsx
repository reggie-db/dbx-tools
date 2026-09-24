import { ChatComposer } from "./chat-composer.tsx";
import { ChatThreadLayout } from "./chat-thread-layout.tsx";
import { ChatTranscript, useChatTranscriptController } from "./chat-transcript.tsx";
import type { ChatViewProps } from "./types.ts";

/**
 * Controlled chat facade for hosts that own message and transport state.
 *
 * Rendering responsibilities are delegated to focused internal thread,
 * transcript, and composer components while this public prop contract remains
 * stable.
 */
export const ChatView = ({
  messages,
  status,
  error,
  sendMessage,
  queuedSteers = [],
  onSendSteerNow,
  onRemoveSteer,
  onReorderSteers,
  regenerate,
  onStop,
  className,
  suggestions = [],
  toolEventsByMessage = {},
  models,
  model,
  onModelChange,
  defaultModelName,
  composerActions,
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
  isLoadingHistory = false,
  onResolveToolApproval,
  pendingApprovalsByMessage = {},
  onClear,
  threads,
  threadPlacement = "auto",
  activeThreadId,
  streamingThreadIds = [],
  isLoadingThreads = false,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onRenameThread,
  onCancelThread,
  sidebarOpen,
  onToggleSidebar,
  onExportConversation,
  onExportMessage,
  feedbackByMessage = {},
  onFeedback,
}: ChatViewProps) => {
  const transcript = useChatTranscriptController({
    messages,
    toolEventsByMessage,
    onLoadMore,
    isLoadingMore,
    hasMore,
    isLoadingHistory,
  });

  return (
    <ChatThreadLayout
      className={className}
      threads={threads}
      threadPlacement={threadPlacement}
      activeThreadId={activeThreadId}
      streamingThreadIds={streamingThreadIds}
      isLoadingThreads={isLoadingThreads}
      onSelectThread={onSelectThread}
      onNewThread={onNewThread}
      onDeleteThread={onDeleteThread}
      onRenameThread={onRenameThread}
      onCancelThread={onCancelThread}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={onToggleSidebar}
    >
      <ChatTranscript
        controller={transcript}
        messages={messages}
        status={status}
        error={error}
        sendMessage={sendMessage}
        suggestions={suggestions}
        toolEventsByMessage={toolEventsByMessage}
        regenerate={regenerate}
        isLoadingMore={isLoadingMore}
        isLoadingHistory={isLoadingHistory}
        onResolveToolApproval={onResolveToolApproval}
        pendingApprovalsByMessage={pendingApprovalsByMessage}
        onExportMessage={onExportMessage}
        feedbackByMessage={feedbackByMessage}
        onFeedback={onFeedback}
      />
      <ChatComposer
        isEmpty={messages.length === 0}
        status={status}
        sendMessage={sendMessage}
        queuedSteers={queuedSteers}
        onSendSteerNow={onSendSteerNow}
        onRemoveSteer={onRemoveSteer}
        onReorderSteers={onReorderSteers}
        onStop={onStop}
        suggestions={suggestions}
        models={models}
        model={model}
        onModelChange={onModelChange}
        defaultModelName={defaultModelName}
        composerActions={composerActions}
        isLoadingHistory={isLoadingHistory}
        onClear={onClear}
        onExportConversation={onExportConversation}
        onResumeFollow={transcript.resumeFollow}
      />
    </ChatThreadLayout>
  );
};
