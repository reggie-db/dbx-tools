import { error as sharedError } from "@dbx-tools/shared-core";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Spinner,
} from "@dbx-tools/ui-appkit/react";
import { ArrowDownIcon, MessageSquareIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssistantBubble, UserBubble } from "./bubbles.tsx";
import type { ChatViewProps } from "./types.ts";

const BOTTOM_THRESHOLD_PX = 24;
const TOP_LOAD_MORE_THRESHOLD_PX = 120;

type ChatTranscriptControllerOptions = {
  messages: ChatViewProps["messages"];
  toolEventsByMessage: NonNullable<ChatViewProps["toolEventsByMessage"]>;
  onLoadMore: ChatViewProps["onLoadMore"];
  isLoadingMore: NonNullable<ChatViewProps["isLoadingMore"]>;
  hasMore: NonNullable<ChatViewProps["hasMore"]>;
  isLoadingHistory: NonNullable<ChatViewProps["isLoadingHistory"]>;
};

/** Shared transcript scrolling actions used by the transcript and composer. */
export type ChatTranscriptController = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  handleScroll: React.UIEventHandler<HTMLDivElement>;
  scrollToBottom: () => void;
  resumeFollow: () => void;
};

/** Owns bottom-following and prepend anchoring for the transcript viewport. */
export const useChatTranscriptController = ({
  messages,
  toolEventsByMessage,
  onLoadMore,
  isLoadingMore,
  hasMore,
  isLoadingHistory,
}: ChatTranscriptControllerOptions): ChatTranscriptController => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const pinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  const pinToBottomNow = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    programmaticScrollRef.current = true;
    element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (prependAnchorRef.current || !pinnedRef.current) return;
      programmaticScrollRef.current = true;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [messages.length, isLoadingHistory]);

  useEffect(() => {
    if (prependAnchorRef.current || !pinnedRef.current) return;
    pinToBottomNow();
  }, [messages, toolEventsByMessage, pinToBottomNow]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = prependAnchorRef.current;
    prependAnchorRef.current = null;
    if (!element || !anchor) return;
    const delta = element.scrollHeight - anchor.scrollHeight;
    element.scrollTop = anchor.scrollTop + delta;
  }, [messages]);

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    const element = event.currentTarget;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX;
    if (programmaticScrollRef.current) programmaticScrollRef.current = false;
    else pinnedRef.current = atBottom;
    setIsAtBottom(atBottom);

    if (
      element.scrollTop <= TOP_LOAD_MORE_THRESHOLD_PX &&
      hasMore &&
      !isLoadingMore &&
      loadMoreRef.current
    ) {
      prependAnchorRef.current = {
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
      loadMoreRef.current();
    }
  };

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = true;
    setIsAtBottom(true);
    programmaticScrollRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, []);

  const resumeFollow = useCallback(() => {
    pinnedRef.current = true;
    setIsAtBottom(true);
    requestAnimationFrame(() => {
      pinToBottomNow();
      requestAnimationFrame(pinToBottomNow);
    });
  }, [pinToBottomNow]);

  return {
    scrollRef,
    contentRef,
    isAtBottom,
    handleScroll,
    scrollToBottom,
    resumeFollow,
  };
};

type ChatTranscriptProps = {
  controller: ChatTranscriptController;
  messages: ChatViewProps["messages"];
  status: ChatViewProps["status"];
  error: ChatViewProps["error"];
  sendMessage: ChatViewProps["sendMessage"];
  suggestions: NonNullable<ChatViewProps["suggestions"]>;
  toolEventsByMessage: NonNullable<ChatViewProps["toolEventsByMessage"]>;
  regenerate: ChatViewProps["regenerate"];
  isLoadingMore: NonNullable<ChatViewProps["isLoadingMore"]>;
  isLoadingHistory: NonNullable<ChatViewProps["isLoadingHistory"]>;
  onResolveToolApproval: ChatViewProps["onResolveToolApproval"];
  pendingApprovalsByMessage: NonNullable<ChatViewProps["pendingApprovalsByMessage"]>;
  onExportMessage: ChatViewProps["onExportMessage"];
  feedbackByMessage: NonNullable<ChatViewProps["feedbackByMessage"]>;
  onFeedback: ChatViewProps["onFeedback"];
};

/** Internal transcript renderer with loading, error, approval, and feedback states. */
export const ChatTranscript = ({
  controller,
  messages,
  status,
  error,
  sendMessage,
  suggestions,
  toolEventsByMessage,
  regenerate,
  isLoadingMore,
  isLoadingHistory,
  onResolveToolApproval,
  pendingApprovalsByMessage,
  onExportMessage,
  feedbackByMessage,
  onFeedback,
}: ChatTranscriptProps) => {
  const isRunning = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const lastEvents = lastMessage ? toolEventsByMessage[lastMessage.id] : undefined;
  const lastAssistantParts = lastMessage?.role === "assistant" ? lastMessage.parts : [];
  const lastAssistantHasContent =
    lastAssistantParts.some(
      (part) =>
        (part.type === "text" || part.type === "reasoning") &&
        Boolean((part as { text?: string }).text),
    ) || (lastEvents?.length ?? 0) > 0;
  const hasRunningTool = (lastEvents ?? []).some((event) => event.status === "running");
  const waitingLabel = !lastAssistantHasContent
    ? "Thinking..."
    : hasRunningTool
      ? "Working..."
      : "Composing response...";

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        ref={controller.scrollRef}
        onScroll={controller.handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        {messages.length === 0 && !isLoadingHistory ? (
          <Empty className="mx-auto h-full w-full max-w-4xl px-4 md:px-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareIcon className="size-5" />
              </EmptyMedia>
              <EmptyTitle>Start a conversation</EmptyTitle>
              <EmptyDescription>
                {suggestions.length > 0
                  ? "Ask anything, or pick a suggestion below."
                  : "Ask anything to get started."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            ref={controller.contentRef}
            className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 md:px-6"
          >
            {(isLoadingMore || isLoadingHistory) && (
              <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                <span>{isLoadingHistory ? "Loading history..." : "Loading older messages..."}</span>
              </div>
            )}
            {messages.map((message, index) => {
              const isLast = index === messages.length - 1;
              if (message.role === "assistant") {
                const messageFeedback = feedbackByMessage[message.id];
                return (
                  <AssistantBubble
                    key={message.id}
                    message={message}
                    isLast={isLast}
                    status={status}
                    events={toolEventsByMessage[message.id]}
                    regenerate={regenerate}
                    onSuggestionClick={(text) => sendMessage({ text })}
                    onResolveToolApproval={onResolveToolApproval}
                    externalApprovals={pendingApprovalsByMessage[message.id]}
                    {...(onExportMessage
                      ? { onExport: (format) => onExportMessage(message, format) }
                      : {})}
                    {...(onFeedback && messageFeedback
                      ? {
                          onFeedback: (submission) => onFeedback(message, submission),
                          ...(messageFeedback.value
                            ? { feedbackValue: messageFeedback.value }
                            : {}),
                        }
                      : {})}
                  />
                );
              }
              return <UserBubble key={message.id} message={message} />;
            })}
            {isRunning && (
              <div className="flex h-7 items-center gap-2 px-3 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                <span className="animate-pulse">{waitingLabel}</span>
              </div>
            )}
            {status === "error" && (
              <div className="flex flex-col items-start gap-2">
                <Alert variant="destructive">
                  <TriangleAlertIcon className="size-4" />
                  <AlertTitle>Something went wrong</AlertTitle>
                  <AlertDescription>
                    {error
                      ? sharedError.errorMessage(error)
                      : "The assistant ran into an error. Please try again."}
                  </AlertDescription>
                </Alert>
                {regenerate && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={regenerate}
                    className="gap-1.5"
                  >
                    <RefreshCwIcon className="size-3" />
                    Retry
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {!controller.isAtBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto flex w-full max-w-4xl justify-end px-4 md:px-6">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={controller.scrollToBottom}
            aria-label="Jump to latest message"
            className="pointer-events-auto rounded-full shadow"
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
};
