import { useState } from "react";
import { ChatComposer } from "./chat-composer.tsx";
import { ChatThreadLayout } from "./chat-thread-layout.tsx";
import { ChatTranscript, useChatTranscriptController } from "./chat-transcript.tsx";
import { collectSuggestions } from "./suggestions.ts";
import { isActiveChatStatus, type ChatViewProps } from "./types.ts";

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
  followUpSuggestions = "none",
  followUpSuggestionLimit = 3,
  toolEventsByMessage = {},
  models,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  defaultModelName,
  defaultModelId,
  defaultModelLoading = false,
  composerActions,
  modelSelectorActions,
  composerLeadingActions,
  allowAttachments = true,
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
  isLoadingHistory = false,
  onResolveToolApproval,
  pendingApprovalsByMessage = {},
  onClear,
  threads,
  threadPlacement = "auto",
  threadBarActions,
  threadHistoryLeadingActions,
  threadSidebarHeaderActions,
  showThreadBarActions = true,
  threadNewIcon,
  threadHistoryIcon,
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
  feedbackModes = [],
  onFeedback,
  mlflowExperimentUrl,
  mlflowTracePrefix,
}: ChatViewProps) => {
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const transcript = useChatTranscriptController({
    messages,
    toolEventsByMessage,
    onLoadMore,
    isLoadingMore,
    hasMore,
    isLoadingHistory,
  });
  const latestMessage = messages[messages.length - 1];
  const latestAssistant = latestMessage?.role === "assistant" ? latestMessage : undefined;
  const running = isActiveChatStatus(status);
  const followUpQuestions =
    latestAssistant && !running
      ? collectSuggestions(
          toolEventsByMessage[latestAssistant.id],
          latestAssistant,
          followUpSuggestions,
          followUpSuggestionLimit,
        )
      : [];
  const startNewThread = onNewThread
    ? () => {
        onNewThread();
        setComposerFocusRequest((request) => request + 1);
      }
    : undefined;

  return (
    <ChatThreadLayout
      className={className}
      threads={threads}
      threadPlacement={threadPlacement}
      threadBarActions={threadBarActions}
      threadHistoryLeadingActions={threadHistoryLeadingActions}
      threadSidebarHeaderActions={threadSidebarHeaderActions}
      showThreadBarActions={showThreadBarActions}
      threadNewIcon={threadNewIcon}
      threadHistoryIcon={threadHistoryIcon}
      activeThreadId={activeThreadId}
      streamingThreadIds={streamingThreadIds}
      isLoadingThreads={isLoadingThreads}
      onSelectThread={onSelectThread}
      onNewThread={startNewThread}
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
        suggestions={suggestions}
        followUpQuestions={followUpQuestions}
        onSelectSuggestion={(text) => sendMessage({ text })}
        toolEventsByMessage={toolEventsByMessage}
        regenerate={regenerate}
        isLoadingMore={isLoadingMore}
        isLoadingHistory={isLoadingHistory}
        onResolveToolApproval={onResolveToolApproval}
        pendingApprovalsByMessage={pendingApprovalsByMessage}
        onExportMessage={onExportMessage}
        feedbackByMessage={feedbackByMessage}
        feedbackModes={feedbackModes}
        onFeedback={onFeedback}
        mlflowExperimentUrl={mlflowExperimentUrl}
        mlflowTracePrefix={mlflowTracePrefix}
      />
      <ChatComposer
        focusRequest={composerFocusRequest}
        status={status}
        sendMessage={sendMessage}
        queuedSteers={queuedSteers}
        onSendSteerNow={onSendSteerNow}
        onRemoveSteer={onRemoveSteer}
        onReorderSteers={onReorderSteers}
        onStop={onStop}
        models={models}
        model={model}
        onModelChange={onModelChange}
        reasoningEffort={reasoningEffort}
        onReasoningEffortChange={onReasoningEffortChange}
        defaultModelName={defaultModelName}
        defaultModelId={defaultModelId}
        defaultModelLoading={defaultModelLoading}
        composerActions={composerActions}
        modelSelectorActions={modelSelectorActions}
        composerLeadingActions={composerLeadingActions}
        allowAttachments={allowAttachments}
        isLoadingHistory={isLoadingHistory}
        onClear={onClear}
        onExportConversation={onExportConversation}
        onResumeFollow={transcript.resumeFollow}
      />
    </ChatThreadLayout>
  );
};
