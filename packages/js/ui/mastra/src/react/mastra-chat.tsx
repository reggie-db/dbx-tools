import { error as sharedError, hash, log } from "@dbx-tools/shared-core";
import type { MastraThread } from "@dbx-tools/shared-mastra";
import { useBrand } from "@dbx-tools/ui-branding/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatApprovals } from "./chat-approvals.ts";
import { ChatView } from "./chat-view.tsx";
import { useChatFeedback } from "./chat-feedback.ts";
import { useChatHistory } from "./chat-history.ts";
import { useChatSessions } from "./chat-sessions.ts";
import { useChatStream } from "./chat-stream.ts";
import { dedupeSuggestions } from "./suggestions.ts";
import type { ChatViewProps, ThreadPlacement, ThreadSummary } from "./types.ts";
import type { EmbedResolver, ExportFormat } from "../support/export.ts";
import {
  useMastraClient,
  useMastraDefaultModel,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
} from "../support/mastra-client.ts";
import type { MastraStreamResponse } from "../support/mastra-stream.ts";
import {
  modelStorageKey,
  readStoredModel,
  storeSelectedModel,
} from "../support/model-selection.ts";
import {
  DEFAULT_THREAD_SESSION_KEY,
  enqueueSteer,
  isSessionRunning,
  removeSteer as removeSteerFromQueue,
  reorderSteers as reorderSteerQueue,
  terminateRunningToolEvents,
  type ThreadSession,
} from "../support/thread-sessions.ts";

const _loadChatExport = () => import("../support/export.ts");

// Self-contained drop-in chat. `useMastraChat` drives the conversation
// over `@mastra/client-js`: `agent.stream()` returns a Response
// augmented with `processDataStream()`, which pushes typed Mastra
// chunks (text-delta, reasoning-delta, tool-*, ...) that we translate
// into `UIMessage` parts for `ChatView` to render.
//
// Approval gates ride the same channel: a paused `requireApproval: true`
// tool call emits a `tool-call-approval` chunk carrying
// `{ runId, payload: { toolCallId, toolName, args } }`. We surface that
// as an out-of-band entry in `pendingApprovalsByMessage` and wire
// `onResolveToolApproval` to {@link MastraPluginClient.approveToolCallStream}
// / `declineToolCallStream` - both of which read SSE directly (avoiding a
// stock `@mastra/client-js` bug on resumed approval streams) and return a
// fresh stream Response we run through the same chunk handler.
//
// On mount the transcript hydrates with the most recent page of thread
// history from the Mastra plugin's `/route/history` endpoint; scrolling near
// the top lazy-loads and prepends the next older page, with `ChatView`
// preserving the visual scroll position across the prepend.

const logger = log.logger("ui-mastra/chat");

const makeUserMessage = (text: string): UIMessage => ({
  id: hash.id(),
  role: "user",
  parts: [{ type: "text", text }],
});

/** Project a wire {@link MastraThread} down to the sidebar's view. */
const toThreadSummary = (thread: MastraThread): ThreadSummary => ({
  id: thread.id,
  ...(thread.title ? { title: thread.title } : {}),
  updatedAt: thread.updatedAt,
});

/** Max characters of the first user message used as a provisional thread title. */
const TITLE_PREVIEW_MAX = 60;

/**
 * Derive a provisional sidebar title from a user's first message:
 * whitespace-collapsed and truncated with an ellipsis. Shown the instant
 * a brand-new conversation gets its first question so the row stops
 * reading "New conversation", until the server's auto-generated title
 * lands and supersedes it.
 */
const deriveThreadTitle = (text: string): string => {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > TITLE_PREVIEW_MAX ? `${clean.slice(0, TITLE_PREVIEW_MAX - 1)}…` : clean;
};

/**
 * `localStorage` key the active thread id is persisted under, namespaced
 * by plugin mount + agent so two agents (or two apps on one origin)
 * don't clobber each other's "current conversation".
 */
const threadStorageKey = (basePath: string, agentId: string): string =>
  `dbx-mastra-thread:${basePath}:${agentId}`;

/** Read the persisted active thread id, tolerating storage being unavailable. */
const readStoredThreadId = (key: string): string | undefined => {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

/** Persist the active thread id, silently ignoring storage failures. */
const storeStoredThreadId = (key: string, id: string): void => {
  try {
    window.localStorage.setItem(key, id);
  } catch {
    // Private-mode / disabled storage: persistence is best-effort, the
    // in-memory selection still works for the session.
  }
};

/**
 * `localStorage` key the conversation sidebar's open/closed state is
 * persisted under, namespaced by plugin mount + agent so the user's
 * show/hide choice survives reloads without clobbering other mounts.
 */
const sidebarStorageKey = (basePath: string, agentId: string): string =>
  `dbx-mastra-sidebar:${basePath}:${agentId}`;

/** Read the persisted sidebar open flag, falling back when unset / unavailable. */
const readStoredSidebarOpen = (key: string, fallback: boolean): boolean => {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
};

/** Persist the sidebar open flag, silently ignoring storage failures. */
const storeStoredSidebarOpen = (key: string, open: boolean): void => {
  try {
    window.localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // Best-effort; the in-session toggle still works without persistence.
  }
};

/** Options for {@link useMastraChat}. */
export interface UseMastraChatOptions {
  /**
   * Agent to converse with. Defaults to the Mastra plugin's registered
   * default agent (`clientConfig().defaultAgent`).
   */
  agentId?: string;
  /**
   * Surface the built-in model picker in the header, letting the user
   * override the serving endpoint per turn (via `X-Mastra-Model`).
   * Off by default so the drop-in renders a clean single-model chat;
   * when `false` the model catalogue isn't even fetched.
   */
  showModelPicker?: boolean;
  /**
   * Starter questions shown as one-tap buttons on the empty state.
   * When omitted, the drop-in auto-sources them from the agent's
   * Genie space sample questions (via the plugin's `/suggestions`
   * endpoint); when the agent has no Genie space the empty state
   * stays bare. Pass an explicit list to override that lookup, or
   * `[]` to force no suggestions.
   */
  suggestions?: string[];
  /**
   * Enable built-in conversation (thread) management: the chat tracks a
   * client-selected thread id, persists it across reloads, lists the
   * resource's conversations, and renders a sidebar to switch between
   * them / start new ones / delete them. On by default. Set `false` for
   * the classic single-thread chat anchored to the per-session cookie
   * (no sidebar, no thread tracking).
   *
   * Shorthand for {@link threadPlacement}: `false` is `"disabled"`. When both
   * are passed, `enableThreads: false` wins.
   */
  enableThreads?: boolean;
  /**
   * Where conversation management renders: `"left"` / `"right"` dock the list
   * to that edge, `"top"` shows the open conversations as an editor-style tab
   * strip with a history menu, `"disabled"` turns thread management off, and
   * the default `"auto"` picks `"left"` while the chat is wide enough for a
   * side panel and `"top"` once it gets too narrow for one (measured on the
   * chat's own width, so an embedded panel decides on its own space).
   */
  threadPlacement?: ThreadPlacement;
  /**
   * Enable chat export. Off by default (opt-in). When on, the header
   * shows an "Export" menu for the whole conversation and each assistant
   * bubble shows a per-message export menu. Both offer PDF (via the
   * browser print dialog) and Markdown; charts and data tables are
   * inlined into the export so it renders reliably offline.
   */
  enableExport?: boolean;
  /**
   * Surface per-message feedback controls (thumbs up/down + a comment
   * popover) that log to MLflow as trace assessments.
   *
   * Defaults to whatever {@link enableExport} is (feedback and export
   * are the two "quality loop" affordances, so turning on export opts
   * into feedback too); pass an explicit `true` / `false` to override.
   * Regardless of this flag, controls only actually render when the
   * server reports MLflow logging is enabled (`clientConfig.feedbackEnabled`)
   * and the turn produced a trace id - so enabling it on a deployment
   * without MLflow tracing is a safe no-op.
   */
  enableFeedback?: boolean;
}

/**
 * Headless driver for the Mastra chat experience. Owns the full
 * conversation lifecycle (streaming, tool-event tracking, approvals,
 * model selection, clear, and infinite-scroll-up history) over
 * `@mastra/client-js` and returns the exact prop bag {@link ChatView}
 * consumes. Use this when you want the drop-in behaviour but need to
 * render the view yourself; otherwise reach for {@link MastraChat}.
 */
export const useMastraChat = (
  options: UseMastraChatOptions = {},
): Omit<ChatViewProps, "className"> => {
  // One client drives both the agent stream and the plugin's custom
  // routes (history / threads / models / suggestions / feedback /
  // embeds). Its identity is
  // stable across renders (memoized on `basePath` / `defaultAgent`) so
  // using it as a hook dep doesn't refire the initial-history fetch on
  // every parent render.
  const mastraClient = useMastraClient();
  const agentId = options.agentId ?? mastraClient.defaultAgent;
  const showModelPicker = Boolean(options.showModelPicker);
  const modelKey = modelStorageKey(mastraClient.basePath, agentId);
  const [model, setModel] = useState(() => (showModelPicker ? readStoredModel(modelKey) : ""));
  const handleModelChange = useCallback(
    (nextModel: string) => {
      setModel(nextModel);
      storeSelectedModel(modelKey, nextModel);
    },
    [modelKey],
  );
  useEffect(() => {
    setModel(showModelPicker ? readStoredModel(modelKey) : "");
  }, [modelKey, showModelPicker]);
  // The selected model rides each turn as a per-call override (see
  // `runStream`), never stored on the shared client - so two threads can
  // stream under different models without clobbering each other. Mirror it
  // into a ref so the send path reads the latest selection without adding
  // `model` to its dependency list.
  const modelRef = useRef(model);
  modelRef.current = model;
  // Built-in conversation management. When on, the chat always drives an
  // explicit client thread id (rather than leaning on the per-session
  // cookie) so it can reference, persist, and switch between the
  // conversations a user owns. Each call (stream / history / clear) carries
  // its thread id per request, so many threads can run concurrently without
  // sharing routing state.
  // `enableThreads: false` is the legacy way to say "no thread management", so
  // it collapses into the placement rather than living as a second flag.
  const threadPlacement: ThreadPlacement =
    options.enableThreads === false ? "disabled" : (options.threadPlacement ?? "auto");
  const enableThreads = threadPlacement !== "disabled";
  // Export is opt-in (default off): the host turns it on explicitly.
  const enableExport = options.enableExport === true;
  // Feedback defaults to export's setting; an explicit option overrides.
  // It only actually surfaces when the server reports MLflow logging is
  // wired (so a trace exists to attach the assessment to).
  const enableFeedback = options.enableFeedback ?? enableExport;
  const feedbackAvailable = enableFeedback && mastraClient.feedbackEnabled;
  const threadKey = threadStorageKey(mastraClient.basePath, agentId);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(() =>
    enableThreads ? (readStoredThreadId(threadKey) ?? hash.id()) : undefined,
  );
  const {
    threads,
    loading: isLoadingThreads,
    refresh: refreshThreads,
  } = useMastraThreads(options.agentId, enableThreads);
  // Persist the active thread id so a reload reopens the same
  // conversation. Best-effort; storage may be unavailable.
  useEffect(() => {
    if (enableThreads && activeThreadId) storeStoredThreadId(threadKey, activeThreadId);
  }, [enableThreads, threadKey, activeThreadId]);
  // Conversation sidebar show/hide, persisted so the user's choice
  // sticks across reloads. The view exposes a header toggle wired to
  // `onToggleSidebar`; defaults open the first time.
  const sidebarKey = sidebarStorageKey(mastraClient.basePath, agentId);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    enableThreads ? readStoredSidebarOpen(sidebarKey, true) : true,
  );
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      storeStoredSidebarOpen(sidebarKey, next);
      return next;
    });
  }, [sidebarKey]);
  // Refresh the conversation list after a turn (a brand-new thread
  // appears, or its auto-generated title lands), a clear, or a delete.
  // Titles are generated server-side after the turn settles, so a short
  // delayed second pass picks them up.
  const refreshThreadsSoon = useCallback(() => {
    if (!enableThreads) return;
    refreshThreads();
    window.setTimeout(refreshThreads, 2000);
  }, [enableThreads, refreshThreads]);
  // Optimistic sidebar rows for conversations the user just started but
  // that the server list hasn't returned yet. A new thread's id is
  // client-minted, and the server only materializes the thread row once
  // the first turn lands (with its auto-title arriving a beat later), so
  // without this the sidebar wouldn't show a brand-new conversation
  // until the delayed post-turn refresh. Keyed by thread id; each entry
  // is pruned once the real server row supersedes it.
  const [optimisticThreads, setOptimisticThreads] = useState<Record<string, ThreadSummary>>({});
  // Optimistic title overrides for threads the user just renamed, keyed
  // by thread id. Applied over the server rows in `sidebarThreads` so the
  // new name shows instantly; each entry is dropped once the server list
  // reports the matching title (or the rename request fails).
  const [renamedThreads, setRenamedThreads] = useState<Record<string, string>>({});
  // Provisional titles derived from a thread's first user message, keyed
  // by thread id. Shown the instant a brand-new conversation gets its
  // first question so the row stops reading "New conversation"; dropped
  // as soon as the server's auto-generated title lands (see the prune
  // effect below). A manual rename (`renamedThreads`) still wins.
  const [provisionalTitles, setProvisionalTitles] = useState<Record<string, string>>({});
  // Surface the active thread in the sidebar immediately (called when its
  // first message is sent). Upserts an untitled row stamped "now" so it
  // sorts to the top; the server row replaces it on the next refresh.
  const noteThreadActivity = useCallback(
    (threadId: string) => {
      if (!enableThreads) return;
      setOptimisticThreads((prev) => ({
        ...prev,
        [threadId]: {
          ...prev[threadId],
          id: threadId,
          updatedAt: new Date().toISOString(),
        },
      }));
    },
    [enableThreads],
  );
  // Picker is opt-in: an omitted (or falsy) `showModelPicker` keeps it
  // hidden and skips the catalogue fetch entirely.
  const { models } = useMastraModels(showModelPicker);
  // The humanized name of the model the active agent falls back to when no
  // model is pinned, so the picker can label its default option. Fetched only
  // when the picker is shown; `null` when the agent's model is dynamic.
  const { defaultModel: defaultModelName } = useMastraDefaultModel(agentId, showModelPicker);
  // Starter suggestions: an explicit `options.suggestions` always
  // wins (including `[]` to force none) and is rendered verbatim;
  // otherwise auto-source the agent's Genie space sample questions.
  // The fetch is skipped when the caller passed an explicit list so we
  // never round-trip for a value we won't use. Genie-sourced questions
  // run through the same dedupe + cap as in-conversation follow-ups so
  // initial and follow-up suggestions behave identically.
  const explicitSuggestions = options.suggestions;
  const { questions: genieSuggestions } = useMastraSuggestions(
    options.agentId,
    explicitSuggestions === undefined,
  );
  const suggestions = useMemo(
    () => explicitSuggestions ?? dedupeSuggestions(genieSuggestions),
    [explicitSuggestions, genieSuggestions],
  );
  const {
    activeKey,
    activeSession,
    getSession,
    removeSession,
    resetSession,
    streamingThreadIds,
    updateSession,
    writeMessages,
  } = useChatSessions(activeThreadId);
  const { isLoadingHistory, isLoadingMore, loadOlderHistory } = useChatHistory({
    activeKey,
    activeThreadId,
    agentId,
    getSession,
    mastraClient,
    updateSession,
    writeMessages,
  });
  const submitFeedback = useChatFeedback({
    activeKey,
    feedbackByMessage: activeSession.feedbackByMessage,
    mastraClient,
    updateSession,
  });
  // Drains the next queued steer when a turn ends. Held in a ref because it
  // closes over `runStream`, which is defined below and itself calls
  // `driveStream` (which invokes this) - the ref breaks that cycle without a
  // stale-closure hazard (assigned each render, same pattern as `loadMoreRef`).
  const drainQueueRef = useRef<(threadId: string) => void>(() => {});

  const processStream = useChatStream({ getSession, updateSession, writeMessages });
  const driveStream = useCallback(
    async (
      threadId: string,
      assistantId: string,
      open: (signal: AbortSignal) => Promise<MastraStreamResponse>,
    ) => {
      const controller = new AbortController();
      let token = 0;
      updateSession(threadId, (session) => {
        session.abortController?.abort();
        token = session.runToken + 1;
        return {
          ...session,
          abortController: controller,
          assistantId,
          runId: session.runId,
          error: null,
          status: "submitted",
          runToken: token,
          // Superseding an in-flight run (a steer that interrupts, or a rapid
          // re-send) stops its stream, so close any pills it left running.
          toolEventsByMessage: terminateRunningToolEvents(session.toolEventsByMessage),
        };
      });
      const runIdRef = { current: getSession(threadId).runId };
      try {
        const stream = await open(controller.signal);
        await processStream(threadId, stream, assistantId, runIdRef, controller.signal);
        updateSession(threadId, (session) => {
          if (session.runToken !== token) return session;
          return {
            ...session,
            status: "ready",
            abortController:
              session.abortController === controller ? null : session.abortController,
            runId: runIdRef.current,
          };
        });
        if (getSession(threadId).runToken === token) {
          refreshThreadsSoon();
          // Turn finished on its own: start the oldest queued steer, if any.
          drainQueueRef.current(threadId);
        }
      } catch (caught) {
        if (getSession(threadId).runToken !== token) return;
        logger.error("stream error", {
          error: sharedError.errorMessage(caught),
        });
        updateSession(threadId, (session) => ({
          ...session,
          error: sharedError.toError(caught),
          status: "error",
          abortController: session.abortController === controller ? null : session.abortController,
          runId: runIdRef.current,
        }));
      }
    },
    [getSession, processStream, refreshThreadsSoon, updateSession],
  );

  const runStream = useCallback(
    (threadId: string, history: UIMessage[]) => {
      const assistantId = hash.id();
      const runId = hash.id();
      updateSession(threadId, (session) => ({
        ...session,
        assistantId,
        runId,
      }));
      // Capture this run's thread + model at send time and pass them per
      // call, so a run keeps its own routing even if the user switches
      // threads or changes the model picker while it streams.
      const streamThreadId = threadId === DEFAULT_THREAD_SESSION_KEY ? undefined : threadId;
      const model = modelRef.current || undefined;
      return driveStream(threadId, assistantId, (signal) => {
        const messages = history.flatMap((m) =>
          m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => ({ role: m.role, content: p.text })),
        );
        return mastraClient.streamAgent({
          agentId,
          messages,
          runId,
          threadId: streamThreadId,
          model,
          signal,
        });
      });
    },
    [driveStream, mastraClient, agentId, updateSession],
  );

  // Start the oldest queued steer as the next turn (FIFO drain). Called from
  // `driveStream` when a turn ends normally; a no-op when the queue is empty.
  // Kept behind `drainQueueRef` so `driveStream` can reach it without a
  // definition cycle.
  drainQueueRef.current = (threadId: string) => {
    const queued = getSession(threadId).queuedSteers;
    if (queued.length === 0) return;
    const [head] = queued;
    updateSession(threadId, (session) => ({
      ...session,
      queuedSteers: removeSteerFromQueue(session.queuedSteers, head.id),
    }));
    const { next } = appendUserMessage(threadId, head.text);
    void runStream(threadId, next);
  };

  // Cancel a thread's in-flight run. Defaults to the active thread (the
  // composer stop button), but takes an explicit thread id so the sidebar
  // can cancel a background thread without switching to it. Aborting one
  // thread's controller leaves every other run streaming - each run owns
  // its own controller and routing.
  const stop = useCallback(
    (threadId?: string) => {
      const key = threadId ?? activeKey;
      updateSession(key, (session) => {
        if (!isSessionRunning(session)) return session;
        session.abortController?.abort();
        return {
          ...session,
          abortController: null,
          runToken: session.runToken + 1,
          error: null,
          status: "ready",
          // Cancelling stops the stream, so close any tool pills still marked
          // running - the closing chunks will never arrive.
          toolEventsByMessage: terminateRunningToolEvents(session.toolEventsByMessage),
        };
      });
    },
    [activeKey, updateSession],
  );

  const handleApproval = useChatApprovals({
    activeKey,
    agentId,
    driveStream,
    getSession,
    mastraClient,
    updateSession,
  });

  // Append a user message to a thread's transcript, stamping `lastUserText`,
  // thread-activity, and a provisional title for a brand-new thread. Returns
  // the pre-append session (so callers can see whether a run was in flight)
  // and the new message list. Shared by send + interrupt.
  const appendUserMessage = useCallback(
    (threadId: string, text: string): { before: ThreadSession; next: UIMessage[] } => {
      updateSession(threadId, (session) => ({ ...session, lastUserText: text }));
      if (activeThreadId) {
        noteThreadActivity(activeThreadId);
        if (getSession(threadId).messages.length === 0) {
          const provisional = deriveThreadTitle(text);
          if (provisional) {
            setProvisionalTitles((prev) =>
              prev[activeThreadId] ? prev : { ...prev, [activeThreadId]: provisional },
            );
          }
        }
      }
      const before = getSession(threadId);
      const next = [...before.messages, makeUserMessage(text)];
      writeMessages(threadId, next);
      return { before, next };
    },
    [activeThreadId, getSession, noteThreadActivity, updateSession, writeMessages],
  );

  // Send a message on the active thread. Submitting while a turn is already
  // streaming ENQUEUES the message as a steer (it waits, no interrupt) - the
  // queue drains oldest-first when the turn ends, or the user fires one early
  // with `sendSteerNow`. An idle submit starts a turn right away.
  const sendMessage = useCallback<ChatViewProps["sendMessage"]>(
    (message) => {
      const text = message.text ?? "";
      if (!text) return;
      const threadId = activeKey;
      if (isSessionRunning(getSession(threadId))) {
        updateSession(threadId, (session) => ({
          ...session,
          queuedSteers: enqueueSteer(session.queuedSteers, { id: hash.id(), text }),
        }));
        return;
      }
      const { next } = appendUserMessage(threadId, text);
      void runStream(threadId, next);
    },
    [appendUserMessage, runStream, activeKey, getSession, updateSession],
  );

  // Fire a queued steer immediately, out of order: remove it from the queue,
  // append it, and start a turn. `runStream`/`driveStream` supersede any
  // in-flight run (abort + runToken bump + settle running pills), so this
  // interrupts the current turn and sends the chosen steer now.
  const sendSteerNow = useCallback(
    (steerId: string) => {
      const threadId = activeKey;
      const steer = getSession(threadId).queuedSteers.find((s) => s.id === steerId);
      if (!steer) return;
      updateSession(threadId, (session) => ({
        ...session,
        queuedSteers: removeSteerFromQueue(session.queuedSteers, steerId),
      }));
      logger.info("steer:send-now", { threadId });
      const { next } = appendUserMessage(threadId, steer.text);
      void runStream(threadId, next);
    },
    [activeKey, appendUserMessage, getSession, runStream, updateSession],
  );

  // Drop a queued steer without sending it.
  const removeSteer = useCallback(
    (steerId: string) => {
      updateSession(activeKey, (session) => ({
        ...session,
        queuedSteers: removeSteerFromQueue(session.queuedSteers, steerId),
      }));
    },
    [activeKey, updateSession],
  );

  // Reorder the queue to match a drag-reorder of the pending steers. The queue
  // then drains (and "send now" fires) in the new order.
  const reorderSteers = useCallback(
    (orderedIds: string[]) => {
      updateSession(activeKey, (session) => ({
        ...session,
        queuedSteers: reorderSteerQueue(session.queuedSteers, orderedIds),
      }));
    },
    [activeKey, updateSession],
  );

  /**
   * Wipe the current thread on the server and reset every piece of
   * client-side state that mirrored it. The session cookie that
   * anchors the thread id is preserved by the server, so the next
   * turn opens against the same (now empty) thread - no reload
   * needed. Suspended approval cards belong to the cleared turns
   * and would be unresolvable anyway, so we drop them too.
   */
  const handleClear = useCallback(async () => {
    const threadId = activeKey;
    try {
      const result = await mastraClient.clearHistory({ agentId, threadId: activeThreadId });
      logger.info("history cleared", { cleared: result.cleared });
    } catch (error) {
      logger.error("history clear error", {
        error: sharedError.errorMessage(error),
      });
    }
    resetSession(threadId, true);
    if (activeThreadId) {
      setOptimisticThreads((prev) => {
        if (!prev[activeThreadId]) return prev;
        const { [activeThreadId]: _drop, ...rest } = prev;
        return rest;
      });
      setProvisionalTitles((prev) => {
        if (!(activeThreadId in prev)) return prev;
        const { [activeThreadId]: _drop, ...rest } = prev;
        return rest;
      });
    }
    refreshThreadsSoon();
  }, [mastraClient, agentId, activeKey, activeThreadId, refreshThreadsSoon, resetSession]);

  const selectThread = useCallback(
    (threadId: string) => {
      if (threadId === activeThreadId) return;
      setActiveThreadId(threadId);
    },
    [activeThreadId],
  );

  const newThread = useCallback(() => {
    const id = hash.id();
    resetSession(id, true);
    setActiveThreadId(id);
  }, [resetSession]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      try {
        const result = await mastraClient.removeThread(threadId, { agentId });
        logger.info("thread deleted", { threadId, deleted: result.deleted });
      } catch (error) {
        logger.error("thread delete error", {
          threadId,
          error: sharedError.errorMessage(error),
        });
      }
      removeSession(threadId);
      setOptimisticThreads((prev) => {
        if (!prev[threadId]) return prev;
        const { [threadId]: _drop, ...rest } = prev;
        return rest;
      });
      setProvisionalTitles((prev) => {
        if (!(threadId in prev)) return prev;
        const { [threadId]: _drop, ...rest } = prev;
        return rest;
      });
      if (threadId === activeThreadId) {
        const id = hash.id();
        resetSession(id, true);
        setActiveThreadId(id);
      }
      refreshThreads();
    },
    [activeThreadId, agentId, mastraClient, refreshThreads, removeSession, resetSession],
  );

  /**
   * Rename a conversation. Optimistically overlays the new title so the
   * sidebar updates instantly (both the server-row overlay and any
   * still-pending optimistic row for a brand-new thread), persists it,
   * then refreshes the list. On failure the overlay is dropped so the
   * real (unchanged) title reappears.
   */
  const renameThread = useCallback(
    async (threadId: string, rawTitle: string) => {
      const title = rawTitle.trim();
      if (!title) return;
      setRenamedThreads((prev) => ({ ...prev, [threadId]: title }));
      setOptimisticThreads((prev) =>
        prev[threadId] ? { ...prev, [threadId]: { ...prev[threadId], id: threadId, title } } : prev,
      );
      try {
        await mastraClient.renameThread(threadId, title, { agentId });
        logger.info("thread renamed", { threadId });
      } catch (error) {
        logger.error("thread rename error", {
          threadId,
          error: sharedError.errorMessage(error),
        });
        setRenamedThreads((prev) => {
          if (!(threadId in prev)) return prev;
          const { [threadId]: _drop, ...rest } = prev;
          return rest;
        });
      }
      refreshThreads();
    },
    [mastraClient, agentId, refreshThreads],
  );

  const regenerate = useCallback(() => {
    const threadId = activeKey;
    const lastUserText = getSession(threadId).lastUserText;
    if (!lastUserText) return;
    const prev = getSession(threadId).messages;
    const lastAssistant = prev.length > 0 && prev.at(-1)?.role === "assistant" ? prev.at(-1) : null;
    const trimmed = lastAssistant ? prev.slice(0, -1) : prev;
    if (lastAssistant) {
      updateSession(threadId, (session) => {
        const { [lastAssistant.id]: _events, ...toolEvents } = session.toolEventsByMessage;
        const { [lastAssistant.id]: _approvals, ...pendingApprovals } =
          session.pendingApprovalsByMessage;
        const { [lastAssistant.id]: _feedback, ...feedback } = session.feedbackByMessage;
        return {
          ...session,
          toolEventsByMessage: toolEvents,
          pendingApprovalsByMessage: pendingApprovals,
          feedbackByMessage: feedback,
        };
      });
    }
    writeMessages(threadId, trimmed);
    void runStream(threadId, trimmed);
  }, [activeKey, getSession, runStream, updateSession, writeMessages]);

  // Chat export (opt-in). Resolves `[chart:<id>]` / `[data:<id>]` embeds
  // straight off the client so the export inlines the same charts /
  // tables the UI renders. Handlers are defined unconditionally (rules of
  // hooks) and only surfaced to ChatView when `enableExport` is on.
  const exportResolver = useMemo<EmbedResolver>(
    () => ({
      chart: (id) => mastraClient.chart(id),
      statement: (id) => mastraClient.statement(id),
    }),
    [mastraClient],
  );
  // Speaker label for the human turns in an export. The resource id is
  // the signed-in user's identity (every thread the client lists is its
  // own), so any owned thread supplies it; fall back to a bare "User"
  // before the first thread lands.
  const exportUserLabel = useMemo(() => {
    const resourceId = threads.find((t) => t.resourceId)?.resourceId;
    return resourceId ? `User (${resourceId})` : "User";
  }, [threads]);
  // Brand styling for the exported document, resolved from the active
  // BrandProvider (or the built-in dbx-tools default when the host wired
  // none). The logo asset id is resolved to a portable data URL so the
  // export is self-contained; colors/font come straight from the context.
  const { context: brandContext, resolveAsset: resolveBrandAsset } = useBrand();
  const exportBrand = useMemo(
    () => ({
      logoDataUrl: resolveBrandAsset(brandContext.assets.logo.light),
      primary: brandContext.colors.primary,
      accent: brandContext.colors.accent,
      foreground: brandContext.colors.foreground,
      fontSans: brandContext.typography.sans,
    }),
    [brandContext, resolveBrandAsset],
  );
  const exportConversation = useCallback(
    async (format: ExportFormat) => {
      const title =
        (activeThreadId && threads.find((t) => t.id === activeThreadId)?.title) || "Conversation";
      try {
        const { exportChat } = await _loadChatExport();
        await exportChat({
          messages: getSession(activeKey).messages,
          format,
          resolver: exportResolver,
          title,
          userLabel: exportUserLabel,
          brand: exportBrand,
        });
      } catch (error) {
        logger.error("conversation export error", {
          format,
          error: sharedError.errorMessage(error),
        });
      }
    },
    [exportResolver, activeThreadId, activeKey, getSession, threads, exportUserLabel, exportBrand],
  );
  const exportMessage = useCallback(
    async (message: UIMessage, format: ExportFormat) => {
      try {
        const { exportChat } = await _loadChatExport();
        await exportChat({
          messages: [message],
          format,
          resolver: exportResolver,
          title: "Message",
          filename: "message",
          userLabel: exportUserLabel,
          brand: exportBrand,
        });
      } catch (error) {
        logger.error("message export error", {
          format,
          error: sharedError.errorMessage(error),
        });
      }
    },
    [exportResolver, exportUserLabel, exportBrand],
  );

  // Merge optimistic rows over the server list, newest first, dropping any
  // optimistic entry the server already returns so a thread is never listed
  // twice.
  const sidebarThreads = useMemo<ThreadSummary[]>(() => {
    // Title overlay precedence per row: a manual rename always wins;
    // otherwise a provisional first-message title fills an untitled row
    // until the server titles the thread.
    const withOverlay = (t: ThreadSummary): ThreadSummary => {
      const renamed = renamedThreads[t.id];
      if (renamed !== undefined) return { ...t, title: renamed };
      if (!t.title && provisionalTitles[t.id] !== undefined) {
        return { ...t, title: provisionalTitles[t.id] };
      }
      return t;
    };
    const server = threads.map(toThreadSummary).map(withOverlay);
    const serverIds = new Set(server.map((t) => t.id));
    const pending = Object.values(optimisticThreads)
      .filter((t) => !serverIds.has(t.id))
      .map(withOverlay)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return [...pending, ...server];
  }, [threads, optimisticThreads, renamedThreads, provisionalTitles]);
  // Once the server list includes a thread we were tracking optimistically,
  // drop the optimistic copy so the map doesn't grow without bound.
  useEffect(() => {
    const serverIds = new Set(threads.map((t) => t.id));
    const stale = Object.keys(optimisticThreads).filter((id) => serverIds.has(id));
    if (stale.length === 0) return;
    setOptimisticThreads((prev) => {
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [threads, optimisticThreads]);
  // Drop a rename overlay once the server list reports the new title, so
  // the map doesn't grow without bound and later server-side title
  // changes aren't masked by a stale override.
  useEffect(() => {
    const settled = threads
      .filter((t) => renamedThreads[t.id] !== undefined && t.title === renamedThreads[t.id])
      .map((t) => t.id);
    if (settled.length === 0) return;
    setRenamedThreads((prev) => {
      const next = { ...prev };
      for (const id of settled) delete next[id];
      return next;
    });
  }, [threads, renamedThreads]);
  // Drop a provisional first-message title once the server reports any
  // real title for that thread, so the auto-generated title takes over.
  useEffect(() => {
    const settled = threads
      .filter((t) => t.title && provisionalTitles[t.id] !== undefined)
      .map((t) => t.id);
    if (settled.length === 0) return;
    setProvisionalTitles((prev) => {
      const next = { ...prev };
      for (const id of settled) delete next[id];
      return next;
    });
  }, [threads, provisionalTitles]);

  return {
    messages: activeSession.messages,
    status: activeSession.status,
    error: activeSession.error,
    sendMessage,
    queuedSteers: activeSession.queuedSteers,
    onSendSteerNow: sendSteerNow,
    onRemoveSteer: removeSteer,
    onReorderSteers: reorderSteers,
    regenerate,
    onStop: stop,
    suggestions,
    toolEventsByMessage: activeSession.toolEventsByMessage,
    pendingApprovalsByMessage: activeSession.pendingApprovalsByMessage,
    onResolveToolApproval: handleApproval,
    // Picker is opt-in: only hand ChatView the catalogue + change
    // handler when `showModelPicker` is on, otherwise the header hides
    // it (ChatView shows it only when both are present).
    models: showModelPicker ? models : undefined,
    model,
    onModelChange: showModelPicker ? handleModelChange : undefined,
    defaultModelName: showModelPicker ? (defaultModelName ?? undefined) : undefined,
    onLoadMore: loadOlderHistory,
    isLoadingMore,
    hasMore: activeSession.hasMoreHistory,
    isLoadingHistory,
    onClear: handleClear,
    threadPlacement,
    // Conversation management: hand ChatView the thread list + handlers
    // only when enabled, so the sidebar stays hidden for the classic
    // single-thread chat (ChatView keys the sidebar off these props).
    ...(enableThreads
      ? {
          threads: sidebarThreads,
          ...(activeThreadId ? { activeThreadId } : {}),
          streamingThreadIds,
          isLoadingThreads,
          onSelectThread: selectThread,
          onNewThread: newThread,
          onDeleteThread: deleteThread,
          onRenameThread: renameThread,
          // Cancel a background thread's run from the sidebar without
          // switching to it.
          onCancelThread: stop,
          // Persisted sidebar visibility, controlled from the driver so
          // the show/hide choice survives reloads.
          sidebarOpen,
          onToggleSidebar: toggleSidebar,
        }
      : {}),
    // Export is opt-in: only expose the handlers (which light up the
    // header + per-message export menus in ChatView) when enabled.
    ...(enableExport
      ? {
          onExportConversation: exportConversation,
          onExportMessage: exportMessage,
        }
      : {}),
    // Feedback: only expose the state + handler (which light up the
    // per-bubble thumbs / comment controls in ChatView) when feedback
    // is enabled AND the server can log to MLflow. `feedbackByMessage`
    // still gates per-message on a captured trace id.
    ...(feedbackAvailable
      ? {
          feedbackByMessage: activeSession.feedbackByMessage,
          onFeedback: submitFeedback,
        }
      : {}),
  };
};

/** Props for {@link MastraChat}. */
export interface MastraChatProps extends UseMastraChatOptions {
  /** Extra classes merged onto the chat's root layout container. */
  className?: string;
}

/**
 * Self-contained chat component. Mount it anywhere under the Mastra
 * plugin and it wires itself from the plugin's published client config
 * (mount paths + default agent) via {@link useMastraChat}, then renders
 * the conversation through {@link ChatView}. The GenieChat-equivalent
 * drop-in: full streaming, tool-session pills, approvals, stop control,
 * history pagination, and built-in conversation management (a sidebar
 * of the resource's threads with select / new / delete, persisted
 * across reloads) - all with no host wiring. The model picker is opt-in
 * via `showModelPicker`; thread management is on by default, laid out per
 * `threadPlacement` (`auto` docks it left and falls back to a tab strip on a
 * narrow chat) and turned off with `threadPlacement: "disabled"`.
 */
export const MastraChat = ({ className, ...options }: MastraChatProps) => {
  const chat = useMastraChat(options);
  return <ChatView {...chat} className={className} />;
};
