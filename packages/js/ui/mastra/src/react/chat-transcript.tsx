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
} from "@databricks/appkit-ui/react";
import { errorMessage } from "@dbx-tools/shared-core";
import { isToolUIPart } from "ai";
import { ArrowDownIcon, MessageSquareIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AssistantBubble, UserBubble } from "./bubbles.tsx";
import { messageFeedbackDestination, mlflowTraceUrl } from "./chat-feedback.ts";
import { SelectedModelPill, selectedModelRoute } from "./selected-model-pill.tsx";
import { SuggestionPills } from "./suggestion-pills.tsx";
import { isActiveChatStatus, type ChatViewProps, type ToolEvent } from "./types.ts";
import { messageText } from "../support/export.ts";

const BOTTOM_THRESHOLD_PX = 24;
const TOP_LOAD_MORE_THRESHOLD_PX = 120;

/** Gestures that indicate the user is intentionally navigating transcript history. */
export const TRANSCRIPT_FOLLOW_CANCEL_EVENTS = ["touchmove", "wheel"] as const;

const assistantMessageHasVisibleContent = (
  message: ChatViewProps["messages"][number],
  events: ToolEvent[] | undefined,
): boolean =>
  message.role === "assistant" &&
  (message.parts.some(
    (part) =>
      ((part.type === "text" || part.type === "reasoning") &&
        Boolean((part as { text?: string }).text)) ||
      isToolUIPart(part) ||
      part.type === "data-tool-call-approval",
  ) ||
    Boolean(events?.length));

/** Find the visible assistant response that owns the current turn footer. */
export const latestVisibleAssistantIndexInTurn = (
  messages: ChatViewProps["messages"],
  toolEventsByMessage: NonNullable<ChatViewProps["toolEventsByMessage"]>,
): number => {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    lastUserIndex = index;
    break;
  }
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (message && assistantMessageHasVisibleContent(message, toolEventsByMessage[message.id])) {
      return index;
    }
  }
  return -1;
};

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
  scrollToBottomNow: () => void;
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
    observer.observe(element);
    return () => observer.disconnect();
  }, [messages.length, isLoadingHistory]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleReaderGesture = () => {
      // A wheel/touch gesture at the bottom may not move the viewport. Let the
      // ensuing scroll event decide whether follow mode should stop so inert
      // or downward gestures cannot detach desktop chat from new content.
      programmaticScrollRef.current = false;
    };
    for (const eventName of TRANSCRIPT_FOLLOW_CANCEL_EVENTS) {
      element.addEventListener(eventName, handleReaderGesture, { passive: true });
    }

    return () => {
      for (const eventName of TRANSCRIPT_FOLLOW_CANCEL_EVENTS) {
        element.removeEventListener(eventName, handleReaderGesture);
      }
    };
  }, []);

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

  const scrollToBottomNow = useCallback(() => {
    pinnedRef.current = true;
    // Native Mobile Safari touch listeners run outside React's delegated event path. Commit the
    // hidden state before mutating scrollTop so the control disappears before the transcript jumps.
    flushSync(() => setIsAtBottom(true));
    pinToBottomNow();
  }, [pinToBottomNow]);

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
    scrollToBottomNow,
    resumeFollow,
  };
};

type ChatTranscriptProps = {
  controller: ChatTranscriptController;
  messages: ChatViewProps["messages"];
  status: ChatViewProps["status"];
  error: ChatViewProps["error"];
  suggestions: NonNullable<ChatViewProps["suggestions"]>;
  followUpQuestions: string[];
  showSelectedModel: NonNullable<ChatViewProps["showSelectedModel"]>;
  onSelectSuggestion: (question: string) => void;
  toolEventsByMessage: NonNullable<ChatViewProps["toolEventsByMessage"]>;
  regenerate: ChatViewProps["regenerate"];
  isLoadingMore: NonNullable<ChatViewProps["isLoadingMore"]>;
  isLoadingHistory: NonNullable<ChatViewProps["isLoadingHistory"]>;
  onResolveToolApproval: ChatViewProps["onResolveToolApproval"];
  pendingApprovalsByMessage: NonNullable<ChatViewProps["pendingApprovalsByMessage"]>;
  onExportMessage: ChatViewProps["onExportMessage"];
  feedbackByMessage: NonNullable<ChatViewProps["feedbackByMessage"]>;
  feedbackModes: NonNullable<ChatViewProps["feedbackModes"]>;
  onFeedback: ChatViewProps["onFeedback"];
  mlflowExperimentUrl: ChatViewProps["mlflowExperimentUrl"];
  mlflowTracePrefix: ChatViewProps["mlflowTracePrefix"];
};

/** Internal transcript renderer with loading, error, approval, and feedback states. */
export const ChatTranscript = ({
  controller,
  messages,
  status,
  error,
  suggestions,
  followUpQuestions,
  showSelectedModel,
  onSelectSuggestion,
  toolEventsByMessage,
  regenerate,
  isLoadingMore,
  isLoadingHistory,
  onResolveToolApproval,
  pendingApprovalsByMessage,
  onExportMessage,
  feedbackByMessage,
  feedbackModes,
  onFeedback,
  mlflowExperimentUrl,
  mlflowTracePrefix,
}: ChatTranscriptProps) => {
  const activeAssistantIndex = latestVisibleAssistantIndexInTurn(messages, toolEventsByMessage);
  const showWaitingIndicator = isActiveChatStatus(status) && activeAssistantIndex === -1;
  const visibleSuggestions = messages.length === 0 ? suggestions : followUpQuestions;
  const scrollToBottomButtonRef = useRef<HTMLButtonElement>(null);
  const scrollToBottomFrameRef = useRef<number | null>(null);
  const scrollToBottomOverflowRef = useRef<string | null>(null);

  const activateScrollToBottomFromTouch = useCallback(() => {
    const transcript = controller.scrollRef.current;
    if (!transcript) {
      controller.scrollToBottomNow();
      return;
    }

    if (scrollToBottomOverflowRef.current === null) {
      scrollToBottomOverflowRef.current = transcript.style.overflowY;
    }

    // WebKit has no public API for stopping an overflow scroller's momentum. Briefly removing
    // overflow terminates that momentum; restoring it one frame later keeps normal scrolling native.
    transcript.style.overflowY = "hidden";
    controller.scrollToBottomNow();
    if (scrollToBottomFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollToBottomFrameRef.current);
    }
    scrollToBottomFrameRef.current = window.requestAnimationFrame(() => {
      transcript.style.overflowY = scrollToBottomOverflowRef.current ?? "";
      scrollToBottomOverflowRef.current = null;
      controller.scrollToBottomNow();
      scrollToBottomFrameRef.current = null;
    });
  }, [controller.scrollRef, controller.scrollToBottomNow]);

  useLayoutEffect(() => {
    const button = scrollToBottomButtonRef.current;
    if (!button) return;

    // React's delegated touch listener may be passive in Mobile Safari. These button-local,
    // non-passive listeners prevent focus transfer without changing transcript gesture handling.
    const handlePointerDown = (event: PointerEvent) => {
      event.preventDefault();
    };
    const handleTouchStart = (event: TouchEvent) => {
      event.preventDefault();
      activateScrollToBottomFromTouch();
    };
    const handleTouchEnd = (event: TouchEvent) => {
      event.preventDefault();
    };

    button.addEventListener("pointerdown", handlePointerDown);
    button.addEventListener("touchstart", handleTouchStart, { passive: false });
    button.addEventListener("touchend", handleTouchEnd, { passive: false });
    return () => {
      if (scrollToBottomFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollToBottomFrameRef.current);
        scrollToBottomFrameRef.current = null;
      }
      const transcript = controller.scrollRef.current;
      if (transcript && scrollToBottomOverflowRef.current !== null) {
        transcript.style.overflowY = scrollToBottomOverflowRef.current;
        scrollToBottomOverflowRef.current = null;
      }
      button.removeEventListener("pointerdown", handlePointerDown);
      button.removeEventListener("touchstart", handleTouchStart);
      button.removeEventListener("touchend", handleTouchEnd);
    };
  }, [activateScrollToBottomFromTouch, controller.scrollRef]);

  return (
    <div className="relative flex min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <div
        ref={controller.scrollRef}
        data-slot="aui_thread-viewport"
        onScroll={controller.handleScroll}
        className="min-h-0 min-w-0 max-w-full flex-1 touch-pan-y overflow-x-hidden overflow-y-scroll overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <div
          ref={controller.contentRef}
          data-slot="aui_thread-content"
          className="mx-auto flex min-h-full min-w-0 w-full max-w-4xl flex-col gap-3 overflow-x-clip px-4 py-3 md:px-6"
        >
          {messages.length === 0 && !isLoadingHistory ? (
            <Empty className="h-full flex-1 px-0">
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
            <>
              {(isLoadingMore || isLoadingHistory) && (
                <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  <span>
                    {isLoadingHistory ? "Loading history..." : "Loading older messages..."}
                  </span>
                </div>
              )}
              {messages.map((message, index) => {
                const isLast = index === activeAssistantIndex;
                if (message.role === "assistant") {
                  const selectedRoute = showSelectedModel ? selectedModelRoute(message) : undefined;
                  const messageFeedback = feedbackByMessage[message.id];
                  const feedbackDestination = messageFeedbackDestination(
                    message,
                    feedbackModes,
                    messageFeedback?.traceId,
                  );
                  const traceUrl = mlflowExperimentUrl
                    ? mlflowTraceUrl(
                        mlflowExperimentUrl,
                        messageFeedback?.traceId,
                        mlflowTracePrefix,
                      )
                    : undefined;
                  const requestMessage = [...messages.slice(0, index)]
                    .reverse()
                    .find((candidate) => candidate.role === "user");
                  const feedbackRequest = requestMessage ? messageText(requestMessage) : "";
                  return (
                    <React.Fragment key={message.id}>
                      {selectedRoute ? <SelectedModelPill route={selectedRoute} /> : null}
                      <AssistantBubble
                        message={message}
                        isLast={isLast}
                        status={status}
                        continuation={messages[index - 1]?.role === "assistant"}
                        events={toolEventsByMessage[message.id]}
                        regenerate={regenerate}
                        onResolveToolApproval={onResolveToolApproval}
                        externalApprovals={pendingApprovalsByMessage[message.id]}
                        {...(onExportMessage
                          ? { onExport: (format) => onExportMessage(message, format) }
                          : {})}
                        {...(onFeedback && feedbackDestination
                          ? {
                              onFeedback: (submission) => onFeedback(message, submission),
                              feedbackMode: feedbackDestination.mode,
                              ...(feedbackRequest ? { feedbackRequest } : {}),
                              ...(messageFeedback?.value
                                ? { feedbackValue: messageFeedback.value }
                                : {}),
                            }
                          : {})}
                        {...(traceUrl ? { mlflowTraceUrl: traceUrl } : {})}
                      />
                    </React.Fragment>
                  );
                }
                return <UserBubble key={message.id} message={message} />;
              })}
              {showWaitingIndicator && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex h-7 items-center px-3 text-muted-foreground"
                >
                  <Spinner className="size-3" />
                  <span className="sr-only">Response in progress</span>
                </div>
              )}
              {status === "error" && (
                <div className="flex flex-col items-start gap-2">
                  <Alert variant="destructive">
                    <TriangleAlertIcon className="size-4" />
                    <AlertTitle>Something went wrong</AlertTitle>
                    <AlertDescription>
                      {error
                        ? errorMessage(error)
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
            </>
          )}
          {!isLoadingHistory && visibleSuggestions.length > 0 && (
            <SuggestionPills
              questions={visibleSuggestions}
              onSelect={onSelectSuggestion}
              orientation="horizontal"
              className="mt-auto pt-3"
            />
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto flex w-full max-w-4xl justify-center px-4 md:px-6">
        <Button
          ref={scrollToBottomButtonRef}
          type="button"
          variant="outline"
          size="icon"
          onClick={controller.scrollToBottomNow}
          aria-label="Jump to latest message"
          aria-hidden={controller.isAtBottom}
          tabIndex={controller.isAtBottom ? -1 : undefined}
          className={
            controller.isAtBottom
              ? "pointer-events-none invisible rounded-full shadow"
              : "pointer-events-auto rounded-full shadow"
          }
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
};
