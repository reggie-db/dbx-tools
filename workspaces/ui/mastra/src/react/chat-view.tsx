import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertTitle,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@dbx-tools/ui-appkit/react";
import { error as errorUtil } from "@dbx-tools/shared-core";
import {
  ArrowDownIcon,
  GripVerticalIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SendHorizontalIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssistantBubble, UserBubble } from "./bubbles";
import { ExportMenu } from "./export-menu";
import { SuggestionPills } from "./suggestion-pills";
import { ThreadSidebar, type ThreadSidebarProps } from "./thread-sidebar";
import type { ChatViewProps } from "./types";

// Controlled, presentational chat shell: the scroll container, header
// (model picker + clear), empty state, transcript of message bubbles,
// and the composer. All conversation state is owned by the caller and
// fed in through props - this component renders it and reports user
// intent back out (send, regenerate, load-more, clear, approve).

const BOTTOM_THRESHOLD_PX = 24;
/**
 * Distance from the top of the scroll container at which we trigger
 * `onLoadMore`. Sized to give the lazy fetch a head-start before the
 * user actually hits the top so the reveal feels seamless.
 */
const TOP_LOAD_MORE_THRESHOLD_PX = 120;

/**
 * Sentinel for "no explicit model" in the Select. Radix's `SelectItem`
 * forbids an empty string `value`, so we map `""` <-> `__default__`
 * across the dropdown boundary.
 */
const DEFAULT_MODEL_VALUE = "__default__";

/** Tailwind's `md` breakpoint (px). Below this the sidebar becomes a drawer. */
const MOBILE_BREAKPOINT_PX = 768;

/**
 * `true` on a phone-width viewport (< {@link MOBILE_BREAKPOINT_PX}). Tracks
 * `matchMedia` so the layout switches live on resize/rotate. SSR-safe: defaults
 * to `false` (desktop) when `window` is unavailable.
 */
const useIsMobile = (): boolean => {
  const query = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return isMobile;
};

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
  onLoadMore,
  isLoadingMore = false,
  hasMore = false,
  isLoadingHistory = false,
  onResolveToolApproval,
  pendingApprovalsByMessage = {},
  onClear,
  threads,
  activeThreadId,
  streamingThreadIds = [],
  isLoadingThreads = false,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onRenameThread,
  onCancelThread,
  sidebarOpen: sidebarOpenProp,
  onToggleSidebar,
  onExportConversation,
  onExportMessage,
  feedbackByMessage = {},
  onFeedback,
}: ChatViewProps) => {
  const [input, setInput] = useState("");
  // Id of the queued steer currently being dragged (pointer drag), for the
  // reorder affordance + drop styling. Null when not dragging. Pointer Events
  // (not native HTML5 drag) so the grip works on touch as well as mouse -
  // `draggable`/`onDrag*` never fire on a touchscreen.
  const [draggingSteerId, setDraggingSteerId] = useState<string | null>(null);
  // Live DOM refs to each queued-steer chip, keyed by steer id, so a pointer
  // drag can hit-test the pointer's Y against each chip's midpoint and reorder
  // as the finger/cursor moves over a neighbour.
  const steerChipRefs = useRef(new Map<string, HTMLDivElement>());
  // Id of the steer under an active pointer drag, mirrored in a ref so the
  // pointermove handler reads it synchronously. React state (`draggingSteerId`)
  // only drives styling and lags a render behind the pointerdown, which on
  // touch dropped the first moves and made the drag feel dead.
  const draggingIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Composer textarea, auto-grown with its content up to the CSS `max-h`.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // `isAtBottom` drives the "jump to latest" button; `pinnedRef` drives the
  // auto-follow. They usually agree, but `pinnedRef` is INTENT (do we want to
  // stick to the bottom?) rather than a measurement, so a fast programmatic
  // pin mid-stream can't be misread as the user scrolling away.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const pinnedRef = useRef(true);
  // Set right before a programmatic `scrollTop` write so the `scroll` event it
  // triggers is ignored by `handleScroll` (only USER scrolls should unpin).
  const programmaticScrollRef = useRef(false);
  // Scroll-anchor state for prepending older messages. When the
  // parent answers an `onLoadMore` call we capture the pre-prepend
  // `scrollHeight`/`scrollTop`; once the new DOM nodes mount we shift
  // `scrollTop` so the previously-visible content stays in place
  // (instead of jumping to the bottom of the new transcript).
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(
    null,
  );
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  // Latest queued steers, read by the pointer-drag move handler so it reorders
  // against the current queue rather than the order captured when the drag began.
  const queuedSteersRef = useRef(queuedSteers);
  queuedSteersRef.current = queuedSteers;

  // Jump the transcript to the bottom, marking the write as programmatic so
  // the resulting scroll event isn't mistaken for the user scrolling away.
  const pinToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Reorder the queued steers to place `draggingId` at the slot whose chip the
  // pointer is currently over, hit-testing the pointer Y against each chip's
  // vertical midpoint. Called continuously during a pointer drag so the queue
  // reflows live under the finger/cursor, then committed via `onReorderSteers`.
  const reorderSteersByPointer = useCallback(
    (draggingId: string, pointerY: number) => {
      if (!onReorderSteers) return;
      const order = queuedSteersRef.current.map((s) => s.id);
      // Build the target order: everything except the dragged id, then insert
      // the dragged id before the first chip whose midpoint is below the
      // pointer (or at the end if the pointer is past them all).
      const rest = order.filter((id) => id !== draggingId);
      let insertAt = rest.length;
      for (let i = 0; i < rest.length; i += 1) {
        const chip = steerChipRefs.current.get(rest[i]);
        if (!chip) continue;
        const box = chip.getBoundingClientRect();
        if (pointerY < box.top + box.height / 2) {
          insertAt = i;
          break;
        }
      }
      const next = [...rest];
      next.splice(insertAt, 0, draggingId);
      // Skip the commit when the order is unchanged, so we don't thrash the
      // parent state on every pointermove tick.
      if (next.length === order.length && next.every((id, i) => id === order[i])) {
        return;
      }
      onReorderSteers(next);
    },
    [onReorderSteers],
  );

  // Follow the bottom as streamed content grows, as long as we're "pinned".
  // A ResizeObserver on the transcript catches every height change - new
  // messages, token-by-token text, async markdown/chart layout, the waiting
  // row - and re-pins reading the FRESH scrollHeight, so the view keeps up
  // with fast streaming. Pinning is intent-driven (`pinnedRef`), not measured
  // off scrollTop, so our own programmatic jumps never look like the user
  // scrolling up. Re-subscribes when the transcript mounts.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => {
      if (prependAnchorRef.current || !pinnedRef.current) return;
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [messages.length, isLoadingHistory]);

  // A new message reference (a turn starting, or a steer appended) re-pins if
  // we were following, catching growth the observer's first callback might
  // race. Skipped during a prepend (the anchor restore below owns that).
  useEffect(() => {
    if (prependAnchorRef.current || !pinnedRef.current) return;
    pinToBottomNow();
  }, [messages, toolEventsByMessage, pinToBottomNow]);

  // Restore the visual scroll position after a prepend. Runs in
  // `useLayoutEffect` so the adjustment happens before the browser
  // paints; an effect would let the new content flash at the top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchorRef.current;
    prependAnchorRef.current = null;
    if (!el || !anchor) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    el.scrollTop = anchor.scrollTop + delta;
  }, [messages]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    // A scroll we caused (a pin) shouldn't change intent - only reconcile the
    // button state. A USER scroll sets intent: scrolling up unpins (stop
    // following); scrolling back to the bottom re-pins (resume following).
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
    } else {
      pinnedRef.current = atBottom;
    }
    setIsAtBottom(atBottom);
    // Lazy-load older messages once the user gets close to the top.
    // Capture the anchor *before* firing the callback so the parent's
    // synchronous state updates don't beat us to the layout effect.
    if (
      el.scrollTop <= TOP_LOAD_MORE_THRESHOLD_PX &&
      hasMore &&
      !isLoadingMore &&
      loadMoreRef.current
    ) {
      prependAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      loadMoreRef.current();
    }
  };

  // The "jump to latest" button: smooth-scroll to the bottom and resume
  // following (re-pin), since the user asked to return to live content.
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setIsAtBottom(true);
    programmaticScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Grow the composer with its content (up to the textarea's CSS `max-h`,
  // after which it scrolls internally), then shrink back as text is removed.
  // Runs on every `input` change so paste / multi-line typing feels native.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // A turn is in flight from the moment the run opens (`submitted`)
  // until the server signals done (`ready`/`error`). Used to gate new
  // submissions and to swap the composer's Send button for Stop.
  const isRunning = status === "submitted" || status === "streaming";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    // Submitting while a turn streams is a steer: the driver hands the text
    // to the live run (or interrupts + resends). Idle submits start a turn.
    sendMessage({ text });
    setInput("");
    // Sending is an explicit "I want to see the response", so resume following
    // even if the user had scrolled up.
    resumeFollow();
  };

  // Resume auto-following the bottom (after a submit): set intent, then jump
  // across two frames so the pin lands AFTER React commits the appended
  // message (a single frame can fire pre-commit). The ResizeObserver keeps it
  // pinned through the subsequent streaming growth.
  const resumeFollow = () => {
    pinnedRef.current = true;
    setIsAtBottom(true);
    requestAnimationFrame(() => {
      pinToBottomNow();
      requestAnimationFrame(pinToBottomNow);
    });
  };


  const lastMessage = messages.at(-1);
  const lastEvents = lastMessage ? toolEventsByMessage[lastMessage.id] : undefined;
  // Single in-flight indicator for the whole turn: visible from the
  // moment the agent run opens (`status === "submitted"`) until the
  // server signals done (`status === "ready"` / `"error"`). The label
  // refines based on what the turn is currently doing so the user
  // gets a finer-grained hint without the spinner blinking on/off
  // between text, tool, and "between-step" phases.
  const lastAssistantParts = lastMessage?.role === "assistant" ? lastMessage.parts : [];
  const lastAssistantHasContent =
    lastAssistantParts.some(
      (p) =>
        (p.type === "text" || p.type === "reasoning") &&
        Boolean((p as { text?: string }).text),
    ) || (lastEvents?.length ?? 0) > 0;
  const hasRunningTool = (lastEvents ?? []).some((e) => e.status === "running");
  const showWaiting = isRunning;
  const waitingLabel = !lastAssistantHasContent
    ? "Thinking..."
    : hasRunningTool
      ? "Working..."
      : "Composing response...";

  // Model display is intent-driven, not load-driven: as soon as the host
  // wires `onModelChange` we reserve the row and show the current model,
  // so it never "pops in" once the async catalogue lands. It renders as a
  // clickable picker only when there's an actual choice (models loaded),
  // otherwise as static text.
  const showModelDisplay = Boolean(onModelChange);
  const modelChangeable = Boolean(models && models.length > 0);
  // Human-readable name for a pinned endpoint id, using the catalogue's
  // `displayName`. Returns undefined until the catalogue has an entry for it,
  // so we never fall back to the raw id (no raw-name flash on load).
  const modelLabel = (name?: string): string | undefined => {
    if (!name) return undefined;
    return models?.find((m) => m.name === name)?.displayName;
  };
  // The default option shows the server's fallback model by its already-
  // humanized name (`defaultModelName` is the server's `displayName`), else a
  // neutral "Default". No "server default" phrasing, no raw id.
  const defaultOptionLabel = defaultModelName || "Default";
  // Label the current model by its human-readable name when a model is pinned
  // and the catalogue has resolved it; else the default-option label. Never
  // shows a raw endpoint id.
  const currentModelLabel = modelLabel(model) || defaultOptionLabel;
  // Picker entries sorted by their human-readable label (case-insensitive).
  const sortedModels = [...(models ?? [])].sort((a, b) =>
    (a.displayName || a.name).localeCompare(b.displayName || b.name, undefined, {
      sensitivity: "base",
    }),
  );
  const showClear = Boolean(onClear);
  const showExport = Boolean(onExportConversation);
  // The conversation sidebar turns on once the host wires both the
  // thread list and a selection handler. A header toggle lets the user
  // show/hide it on demand. Open state is controlled when the caller
  // supplies `sidebarOpen` + `onToggleSidebar` (the driver does this and
  // persists the choice); otherwise the view manages a session-only
  // open flag. Defaults to open.
  const showSidebar = Boolean(threads && onSelectThread);
  const [internalSidebarOpen, setInternalSidebarOpen] = useState(true);
  // Desktop inline-sidebar open state (persisted by the driver when it
  // supplies `sidebarOpen`/`onToggleSidebar`, else a session-only flag).
  const desktopSidebarOpen = sidebarOpenProp ?? internalSidebarOpen;
  const toggleDesktopSidebar = () => {
    if (onToggleSidebar) onToggleSidebar();
    else setInternalSidebarOpen((open) => !open);
  };
  // Are we on a phone-width viewport (< md / 768px)? Drives whether the
  // sidebar renders inline (desktop) or as an overlay drawer (mobile), and
  // which open-state the header toggle flips.
  const isMobile = useIsMobile();
  // Mobile drawer is a SESSION-only, default-closed state so a persisted
  // "open" desktop preference never auto-opens the drawer over the chat on a
  // phone. Reset closed whenever we drop back to a mobile viewport.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setMobileDrawerOpen(false);
  }, [isMobile]);
  // Unified state/handlers the render + header use, resolved by viewport.
  const sidebarOpen = isMobile ? mobileDrawerOpen : desktopSidebarOpen;
  const toggleSidebar = () => {
    if (isMobile) setMobileDrawerOpen((open) => !open);
    else toggleDesktopSidebar();
  };
  // The top bar carries only the sidebar toggle; the model picker, export, and
  // clear controls live in a toolbar row below the composer, closer to where
  // the user is typing. The toggle is a mobile hamburger, or a desktop "show"
  // affordance while the inline sidebar is collapsed - so the bar renders only
  // when that toggle would actually be visible (an open desktop sidebar has its
  // own hide button, leaving nothing for the bar to hold).
  const showSidebarToggle = showSidebar && (isMobile || !desktopSidebarOpen);
  const showHeader = showSidebarToggle;
  const showComposerToolbar = showModelDisplay || showExport || showClear;

  // Props shared by the mobile drawer and the desktop inline sidebar - the two
  // render the SAME `ThreadSidebar`, differing only in framing (overlay vs.
  // inline) and, on mobile, closing the drawer after select / new. Building
  // the prop bag once keeps the two call sites from drifting.
  const sidebarProps: ThreadSidebarProps = {
    threads: threads ?? [],
    ...(activeThreadId ? { activeThreadId } : {}),
    streamingThreadIds,
    isLoading: isLoadingThreads,
    onSelect: (id) => onSelectThread?.(id),
    onHide: toggleSidebar,
    ...(onNewThread ? { onNew: onNewThread } : {}),
    ...(onDeleteThread ? { onDelete: onDeleteThread } : {}),
    ...(onRenameThread ? { onRename: onRenameThread } : {}),
    ...(onCancelThread ? { onCancel: onCancelThread } : {}),
  };

  // Clear confirmation is an AppKit `AlertDialog` (a real modal), plus an
  // in-flight flag so the DELETE can't be double-fired. `clearing` disables
  // the confirm action while `onClear` runs; the dialog closes on settle.
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClearConfirm = async () => {
    if (clearing || !onClear) return;
    setClearing(true);
    try {
      await onClear();
      setClearOpen(false);
    } finally {
      setClearing(false);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      {/*
       * Outer row hosts the optional conversation sidebar beside the
       * chat column. The chat column owns the vertical layout and the
       * scroll; the centered `max-w-4xl` framing lives on each section
       * (header, transcript, suggestions, composer) instead of the
       * outer shell, so the scroll area's scrollbar sits at the far
       * right - outside the centered column - and the composer lines up
       * with the message column regardless of whether a scrollbar is
       * showing.
       */}
      <div className={cn("flex h-full min-h-0", className)}>
        {showSidebar &&
          (isMobile ? (
            /*
             * Mobile: a fixed overlay drawer with a tap-to-close backdrop, so
             * the conversation list never eats horizontal space from the chat
             * on a phone. Selecting a thread / starting a new one also closes
             * the drawer so the transcript comes back into view. Session-only
             * + default closed (see `mobileDrawerOpen`).
             */
            mobileDrawerOpen && (
              <div className="fixed inset-0 z-40 flex">
                <div
                  className="absolute inset-0 bg-black/50"
                  onClick={toggleSidebar}
                  aria-hidden="true"
                />
                <ThreadSidebar
                  {...sidebarProps}
                  onSelect={(id) => {
                    onSelectThread?.(id);
                    toggleSidebar();
                  }}
                  {...(onNewThread
                    ? {
                        onNew: () => {
                          onNewThread();
                          toggleSidebar();
                        },
                      }
                    : {})}
                  className="relative z-10 w-[85vw] max-w-xs shadow-xl"
                />
              </div>
            )
          ) : (
            /*
             * Desktop: an inline flex child sharing the row with the chat
             * column, using the persisted open/hide preference. Same
             * `sidebarProps` as mobile - only the framing + close-on-select
             * differ.
             */
            desktopSidebarOpen && <ThreadSidebar {...sidebarProps} />
          ))}
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {showHeader && (
            /*
             * Slim top bar holding the sidebar toggle. On mobile the toggle is
             * a persistent hamburger (the overlay drawer has no always-visible
             * hide button); on desktop it's a "show" affordance rendered only
             * while the inline sidebar is collapsed (an open sidebar has its
             * own hide button). `showHeader` already tracks that visibility, so
             * the bar never renders empty.
             */
            <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-3 pb-2 pt-1 text-xs text-muted-foreground md:gap-3 md:px-6">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleSidebar}
                    aria-label={sidebarOpen ? "Hide conversations" : "Show conversations"}
                  >
                    <PanelLeftIcon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {sidebarOpen ? "Hide conversations" : "Show conversations"}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
          <div className="relative flex flex-1 flex-col overflow-hidden">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              // `overflow-anchor:none` stops the browser's scroll anchoring
              // from fighting the programmatic bottom-pin as streamed content
              // grows (it would otherwise lock onto a mid-transcript element).
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
                  ref={contentRef}
                  className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 md:px-6"
                >
                  {(isLoadingMore || isLoadingHistory) && (
                    <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
                      <Spinner className="size-3" />
                      <span>
                        {isLoadingHistory
                          ? "Loading history..."
                          : "Loading older messages..."}
                      </span>
                    </div>
                  )}
                  {messages.map((message, i) => {
                    const isLast = i === messages.length - 1;
                    if (message.role === "assistant") {
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
                            ? {
                                onExport: (format) => onExportMessage(message, format),
                              }
                            : {})}
                          {...(onFeedback && feedbackByMessage[message.id]
                            ? {
                                onFeedback: (submission) =>
                                  onFeedback(message, submission),
                                ...(feedbackByMessage[message.id]?.value
                                  ? {
                                      feedbackValue:
                                        feedbackByMessage[message.id]!.value,
                                    }
                                  : {}),
                              }
                            : {})}
                        />
                      );
                    }
                    return <UserBubble key={message.id} message={message} />;
                  })}
                  {showWaiting && (
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
                            ? errorUtil.errorMessage(error)
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
            {!isAtBottom && (
              <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 mx-auto flex w-full max-w-4xl justify-end px-4 md:px-6">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={scrollToBottom}
                  className="pointer-events-auto rounded-full shadow"
                >
                  <ArrowDownIcon className="size-4" />
                </Button>
              </div>
            )}
          </div>

          {messages.length === 0 && (
            <SuggestionPills
              questions={suggestions}
              onSelect={(s) => sendMessage({ text: s })}
              className="mx-auto w-full max-w-4xl px-4 pb-2 md:px-6"
            />
          )}

          <form
            onSubmit={handleSubmit}
            className="mx-auto w-full max-w-4xl px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6"
          >
            {queuedSteers.length > 0 && (
              // Steers submitted while the turn is running, waiting to send.
              // They drain oldest-first when the turn ends; each can be fired
              // now (interrupts), removed, or dragged to reorder the queue.
              <div className="mb-2 flex flex-col gap-1">
                {queuedSteers.map((steer) => {
                  const reorderable = Boolean(onReorderSteers);
                  return (
                  <div
                    key={steer.id}
                    ref={(el) => {
                      if (el) steerChipRefs.current.set(steer.id, el);
                      else steerChipRefs.current.delete(steer.id);
                    }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2 py-1 text-xs",
                      draggingSteerId === steer.id && "opacity-50",
                    )}
                  >
                    {reorderable && (
                      // Drag handle. Pointer Events (not native HTML5 drag) so
                      // it works on touch: `touch-none` (touch-action: none)
                      // stops the browser treating the drag as a scroll, and
                      // pointer capture keeps move/up events flowing to the grip
                      // even as the finger slides over sibling chips. The active
                      // id lives in a ref (`draggingIdRef`) so the first
                      // pointermove isn't dropped waiting for a state re-render.
                      // `-m-1 p-1` enlarges the tap target to ~28px without
                      // widening the visible grip - a 12px icon is too small to
                      // reliably grab on touch.
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label="Drag to reorder"
                        className="-m-1 shrink-0 cursor-grab touch-none p-1 text-muted-foreground active:cursor-grabbing"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          draggingIdRef.current = steer.id;
                          setDraggingSteerId(steer.id);
                        }}
                        onPointerMove={(e) => {
                          if (draggingIdRef.current !== steer.id) return;
                          reorderSteersByPointer(steer.id, e.clientY);
                        }}
                        onPointerUp={(e) => {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                          draggingIdRef.current = null;
                          setDraggingSteerId(null);
                        }}
                        onPointerCancel={() => {
                          draggingIdRef.current = null;
                          setDraggingSteerId(null);
                        }}
                      >
                        <GripVerticalIcon className="size-3" aria-hidden="true" />
                      </span>
                    )}
                    <span className="text-muted-foreground">Queued</span>
                    <span className="min-w-0 flex-1 truncate">{steer.text}</span>
                    {onSendSteerNow && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-6 shrink-0"
                            onClick={() => onSendSteerNow(steer.id)}
                            aria-label="Send now (interrupts current turn)"
                          >
                            <SendHorizontalIcon className="size-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Send now — interrupts</TooltipContent>
                      </Tooltip>
                    )}
                    {onRemoveSteer && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-6 shrink-0"
                            onClick={() => onRemoveSteer(steer.id)}
                            aria-label="Remove queued message"
                          >
                            <XIcon className="size-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Remove</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
            <InputGroup className="rounded-2xl border-border/80 shadow-sm transition-shadow focus-within:shadow-md">
              <InputGroupTextarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e as unknown as React.FormEvent);
                  }
                }}
                placeholder="Send a message..."
                rows={1}
                className="max-h-48 text-base md:text-sm"
              />
              <InputGroupAddon align="inline-end">
                {isRunning && onStop && !input.trim() ? (
                  // Running with an empty composer: the button stops the turn.
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    variant="default"
                    onClick={() => onStop()}
                    aria-label="Stop response"
                  >
                    <SquareIcon className="size-3 fill-current" />
                  </InputGroupButton>
                ) : (
                  <>
                    {/*
                     * The primary button sends. Submitting while a turn is
                     * running is a "send now": it interrupts the live run and
                     * starts a fresh turn with this message immediately (see
                     * the driver's sendMessage). Idle, it just sends.
                     */}
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant="default"
                      disabled={!input.trim()}
                      aria-label={isRunning ? "Send now (interrupts)" : "Send message"}
                    >
                      <SendIcon className="size-3" />
                    </InputGroupButton>
                  </>
                )}
              </InputGroupAddon>
            </InputGroup>
            {showComposerToolbar && (
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                {showModelDisplay &&
                  (modelChangeable ? (
                    <Select
                      value={model ? model : DEFAULT_MODEL_VALUE}
                      onValueChange={(v) =>
                        onModelChange?.(v === DEFAULT_MODEL_VALUE ? "" : v)
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-7 w-auto max-w-[200px] gap-1 rounded-full px-2.5 text-xs [&_svg]:size-3"
                      >
                        <SelectValue placeholder={defaultOptionLabel} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_MODEL_VALUE}>
                          {defaultOptionLabel}
                        </SelectItem>
                        {sortedModels.map((m) => (
                          <SelectItem key={m.name} value={m.name}>
                            {m.displayName || m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="max-w-[200px] truncate px-2.5 text-xs text-muted-foreground">
                      {currentModelLabel}
                    </span>
                  ))}
                {showExport && (
                  <ExportMenu
                    onExport={(format) => void onExportConversation?.(format)}
                    tooltip="Export conversation"
                  />
                )}
                {showClear && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setClearOpen(true)}
                          className="h-7 gap-1 rounded-full px-2.5 text-xs [&_svg]:size-3"
                        >
                          <Trash2Icon className="size-3" />
                          Clear
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Clear chat history for this thread</TooltipContent>
                    </Tooltip>
                    <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Clear this conversation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently deletes the chat history for this thread. This
                            can&apos;t be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={(e) => {
                              // Keep the dialog open while the DELETE runs; we
                              // close it ourselves once `onClear` settles.
                              e.preventDefault();
                              void handleClearConfirm();
                            }}
                            disabled={clearing}
                          >
                            {clearing ? <Spinner className="size-3" /> : null}
                            {clearing ? "Clearing..." : "Clear"}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}
              </div>
            )}
          </form>
        </div>
      </div>
    </TooltipProvider>
  );
};
