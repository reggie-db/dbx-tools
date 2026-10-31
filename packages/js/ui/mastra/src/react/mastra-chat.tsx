import { getAuthStatus } from "@dbx-tools/shared-auth";
import { hash, log, toError } from "@dbx-tools/shared-core";
import {
  isStaleMastraResumeError,
  type GenieVisualizationMode,
  type ModelRoutePartData,
  type ModelUsagePartData,
} from "@dbx-tools/shared-mastra";
import type { ReasoningEffort } from "@dbx-tools/shared-model";
import type { AiDecideStrategy } from "@dbx-tools/shared-model-gateway";
import { useBrand } from "@dbx-tools/ui/branding/react";
import type { RequestContext } from "@mastra/client-js";
import type { FileUIPart, UIMessage } from "ai";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toChronologicalUiMessages } from "./_history-messages.ts";
import { useChatApprovals } from "./chat-approvals.ts";
import { useChatFeedback } from "./chat-feedback.ts";
import { useChatHistory } from "./chat-history.ts";
import { useChatSessions } from "./chat-sessions.ts";
import { useChatStream, waitForTerminalChunk } from "./chat-stream.ts";
import { ChatView } from "./chat-view.tsx";
import { dedupeSuggestions } from "./suggestions.ts";
import type { ChatViewProps, ThreadPlacement, ThreadSummary } from "./types.ts";
import {
  activeRunStorageKey,
  readStoredActiveRuns,
  removeStoredActiveRun,
  storeActiveRun,
} from "../support/active-runs.ts";
import {
  browserTranscriptStorageKey,
  readStoredBrowserTranscript,
  storeBrowserTranscript,
  withBrowserMessageTimestamps,
} from "../support/browser-transcript.ts";
import type { EmbedResolver, ExportFormat } from "../support/export.ts";
import { GenieChatClient } from "../support/genie-client.ts";
import {
  useMastraClient,
  useMastraConfig,
  useMastraDefaultModel,
  useMastraMlflowExperiment,
  useMastraModels,
  useMastraSuggestions,
  useMastraThreads,
  MastraChatRequestError,
  type MastraMemoryThread,
  type MastraStreamResponse,
} from "../support/mastra-client.ts";
import {
  defaultReasoningEffort,
  modelStorageKey,
  readStoredModel,
  storeSelectedModel,
} from "../support/model-selection.ts";
import {
  snapshotRequestContext,
  type MastraRequestContextSource,
} from "../support/request-context.ts";
import { threadStorageKey } from "../support/thread-persistence.ts";
import {
  conversationRequestMessages,
  type ConversationHistorySource,
  DEFAULT_THREAD_SESSION_KEY,
  enqueueSteer,
  interruptedTurnMessages,
  isSessionRunning,
  lastUserMessage,
  removeSteer as removeSteerFromQueue,
  reorderSteers as reorderSteerQueue,
} from "../support/thread-sessions.ts";

const _loadChatExport = () => import("../support/export.ts");
const EMPTY_REASONING_EFFORTS: readonly ReasoningEffort[] = [];

/** Why the active managed thread changed. */
export type ThreadIdChangeReason = "hydrate" | "select" | "new" | "delete" | "missing" | "resolve";

/** Browser transcript persistence limits for agents without durable Mastra memory. */
export interface BrowserConversationPersistenceOptions {
  /** Newest messages retained per thread. Defaults to 100. */
  maxMessages?: number;
}

// Self-contained drop-in chat. `useMastraChat` consumes native AI SDK
// `UIMessage` streams through one client contract: Mastra agents use the
// official chat route and direct Genie projects its events onto that wire.
// `ChatView` and the thread session state are transport-agnostic.
//
// Approval gates ride the same channel: a paused `requireApproval: true`
// tool call emits a `tool-call-approval` chunk carrying
// `{ runId, payload: { toolCallId, toolName, args } }`. The native stream
// converter preserves that data part and wires
// `onResolveToolApproval` to {@link MastraPluginClient.approveToolCallStream}
// / `declineToolCallStream`. Both use the native per-request Mastra client and
// return a fresh native stream Response we run through the same chunk handler.
//
// On mount the transcript hydrates with the most recent page of thread
// history from Mastra's resource-scoped memory endpoint; scrolling near the
// top lazy-loads and prepends the next older page, with `ChatView`
// preserving the visual scroll position across the prepend.

const logger = log.logger("ui-mastra/chat");
const STEER_INTERRUPT_SETTLEMENT_TIMEOUT_MS = 2_000;

const makeUserMessage = (text: string, files: FileUIPart[] = []): UIMessage =>
  withBrowserMessageTimestamps(
    {
      id: hash.id(),
      role: "user",
      parts: [...files, ...(text ? [{ type: "text" as const, text }] : [])],
    },
    { createdAt: new Date().toISOString() },
  );

/** Project a native Mastra memory thread down to the sidebar's view. */
const toThreadSummary = (thread: MastraMemoryThread): ThreadSummary => ({
  id: thread.id,
  ...(thread.title ? { title: thread.title } : {}),
  updatedAt: new Date(thread.updatedAt).toISOString(),
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
export interface UseMastraChatOptions<
  TValues extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Agent to converse with. Defaults to the Mastra plugin's registered
   * default agent (`clientConfig().defaultAgent`). Ignored when
   * {@link genieSpace} is set.
   */
  agentId?: string;
  /**
   * Converse with this Genie space alias directly instead of an agent. Every
   * turn is one Genie message streamed as an `ask_genie` tool call, so pills,
   * thoughts, suggestions, and embeds render exactly as in an agent chat.
   * Genie owns visible conversation state. When configured, the server adds
   * resource-scoped Mastra recall and saves completed turns. Conversations
   * cannot be renamed, turns take no attachments, and feedback is unavailable.
   */
  genieSpace?: string;
  /**
   * Direct Genie visualization renderer. `"appkit"` keeps the current local
   * Chart/Table rendering; `"image"` displays the PNG produced by Genie while
   * retaining the backing Table tab.
   */
  genieVisualization?: GenieVisualizationMode;
  /**
   * Surface the built-in model picker in the header, letting the user
   * override the serving endpoint per turn (via `X-Mastra-Model`).
   * Off by default so the drop-in renders a clean single-model chat;
   * when `false` the model catalogue isn't even fetched.
   */
  showModelPicker?: boolean;
  /**
   * Fixed per-instance model override. Unlike the model picker selection, this
   * is not persisted by agent id, so parallel views of the same agent can each
   * route through a different model or family query.
   */
  model?: string;
  /** Optimization objective used when {@link model} is the `ai-decide` virtual model. */
  aiDecideStrategy?: AiDecideStrategy;
  /**
   * Conversation context source. `"memory"` sends only the newest message and
   * lets Mastra's stored thread remain authoritative. `"browser"` sends the
   * full browser-held transcript, as Mastra recommends for agents without memory.
   * Defaults to `"memory"` for backward compatibility.
   */
  conversationHistory?: ConversationHistorySource;
  /**
   * Persist the browser-held transcript in local storage so it survives page
   * reloads and application restarts. Use with `conversationHistory="browser"`
   * when Mastra memory is intentionally disabled. `true` uses the default
   * 100-message limit.
   */
  browserPersistence?: boolean | BrowserConversationPersistenceOptions;
  /**
   * Whether a message submitted during an active turn waits in the steer
   * queue. Defaults to true. Set false to interrupt the active turn and start
   * the replacement immediately.
   */
  queueMessages?: boolean;
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
   * the default `"auto"` picks `"right"` while the chat is wide enough for a
   * side panel and `"top"` once it gets too narrow for one (measured on the
   * chat's own width, so an embedded panel decides on its own space).
   */
  threadPlacement?: ThreadPlacement;
  /**
   * Host-selected managed thread id. Use this to restore a thread from a URL
   * or another external state owner. Changes after mount switch the active
   * conversation without remounting the chat.
   */
  threadId?: string;
  /**
   * Receives every chat-owned thread change. Missing externally selected
   * threads are replaced with a new local thread and reported as `"missing"`.
   */
  onThreadIdChange?: (threadId: string, reason: ThreadIdChangeReason) => void;
  /**
   * Enable chat export. Off by default (opt-in). When on, the header
   * shows an "Export" menu for the whole conversation and each assistant
   * bubble shows a per-message export menu. Both offer PDF (via the
   * browser print dialog) and Markdown; charts and data tables are
   * inlined into the export so it renders reliably offline.
   */
  enableExport?: boolean;
  /**
   * Show the destructive Clear conversation action. Off by default because
   * thread management already provides new/delete controls and most chats do
   * not need a second way to erase the active conversation.
   */
  enableClear?: boolean;
  /**
   * Surface per-message feedback controls for the destination selected by the
   * server. Genie Agent Mode posts Rating and Comment to Genie; traced agent
   * mode posts thumbs/comment assessments to MLflow.
   */
  enableFeedback?: boolean;
  /**
   * Typed application metadata forwarded through Mastra's native
   * `requestContext` field. A resolver is read when each turn is submitted.
   */
  requestContext?: MastraRequestContextSource<TValues>;
  /** Receives the concrete model route before response generation begins. */
  onModelRoute?: (route: ModelRoutePartData) => void;
  /** Receives the resolved model and latest cumulative usage as model steps complete. */
  onModelUsage?: (usage: ModelUsagePartData) => void;
}

/** Headless Mastra chat state and handlers consumed by {@link ChatView}. */
export type UseMastraChatResult = Omit<ChatViewProps, "className"> & {
  /** Whether the active browser transcript has finished restoring. */
  browserPersistenceHydrated: boolean;
};

/**
 * Headless driver for the Mastra chat experience. Owns the full
 * conversation lifecycle (streaming, tool-event tracking, approvals,
 * model selection, clear, and infinite-scroll-up history) over
 * `@mastra/client-js` and returns the exact prop bag {@link ChatView}
 * consumes. Use this when you want the drop-in behaviour but need to
 * render the view yourself; otherwise reach for {@link MastraChat}.
 */
export const useMastraChat = <TValues extends Record<string, unknown> = Record<string, unknown>>(
  options: UseMastraChatOptions<TValues> = {},
): UseMastraChatResult => {
  // One client drives both the agent stream and the plugin's custom
  // routes (history / threads / models / suggestions / feedback /
  // embeds). Its identity is
  // stable across renders (memoized on `basePath` / `defaultAgent`) so
  // using it as a hook dep doesn't refire the initial-history fetch on
  // every parent render.
  const pluginClient = useMastraClient();
  const mastraConfig = useMastraConfig();
  const genieSpace = options.genieSpace?.trim() || undefined;
  const genieVisualization = options.genieVisualization;
  const genieClient = useMemo(
    () =>
      genieSpace ? new GenieChatClient(mastraConfig, genieSpace, genieVisualization) : undefined,
    // Same scalars `useMastraClient` keys on; `mastraConfig` identity churns.
    [genieSpace, genieVisualization, mastraConfig.basePath, mastraConfig.defaultAgent],
  );
  const mastraClient = genieClient ?? pluginClient;
  // Genie chats key persisted state (active thread, sidebar) by space alias.
  const agentId = genieSpace
    ? `genie:${genieSpace}`
    : (options.agentId ?? mastraClient.defaultAgent);
  const showModelPicker = Boolean(options.showModelPicker) && !genieSpace;
  const controlledModel = options.model?.trim() || undefined;
  const queueMessages = options.queueMessages !== false;
  const conversationHistory = options.conversationHistory ?? "memory";
  const browserPersistence =
    options.browserPersistence === true
      ? {}
      : options.browserPersistence === false
        ? undefined
        : options.browserPersistence;
  const modelKey = modelStorageKey(mastraClient.basePath, agentId);
  const [model, setModel] = useState(() => (showModelPicker ? readStoredModel(modelKey) : ""));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | undefined>();
  const handleModelChange = useCallback(
    (nextModel: string) => {
      setModel(nextModel);
      storeSelectedModel(modelKey, nextModel);
    },
    [modelKey],
  );
  useEffect(() => {
    setModel(showModelPicker && !controlledModel ? readStoredModel(modelKey) : "");
  }, [controlledModel, modelKey, showModelPicker]);
  // The selected model rides each turn as a per-call override (see
  // `runStream`), never stored on the shared client - so two threads can
  // stream under different models without clobbering each other. Mirror it
  // into a ref so the send path reads the latest selection without adding
  // `model` to its dependency list.
  const modelRef = useRef(model);
  modelRef.current = controlledModel ?? model;
  const reasoningEffortRef = useRef(reasoningEffort);
  reasoningEffortRef.current = reasoningEffort;
  const aiDecideStrategyRef = useRef(options.aiDecideStrategy);
  aiDecideStrategyRef.current = options.aiDecideStrategy;
  const requestContextRef = useRef(options.requestContext);
  requestContextRef.current = options.requestContext;
  const modelRouteRef = useRef(options.onModelRoute);
  modelRouteRef.current = options.onModelRoute;
  const handleModelRoute = useCallback((route: ModelRoutePartData) => {
    modelRouteRef.current?.(route);
  }, []);
  const modelUsageRef = useRef(options.onModelUsage);
  modelUsageRef.current = options.onModelUsage;
  const handleModelUsage = useCallback((usage: ModelUsagePartData) => {
    modelUsageRef.current?.(usage);
  }, []);
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
  // Clearing is destructive and redundant with managed thread deletion, so
  // the drop-in exposes it only when a host explicitly opts in.
  const enableClear = options.enableClear === true;
  // Feedback defaults to automatic server capability detection. An explicit
  // false hides it; true keeps it requested but cannot bypass the server gate.
  const enableFeedback = options.enableFeedback !== false;
  const feedbackModes = enableFeedback ? mastraClient.feedbackModes : [];
  const feedbackAvailable = feedbackModes.length > 0;
  const { url: mlflowExperimentUrl, tracePrefix: mlflowTracePrefix } = useMastraMlflowExperiment(
    feedbackModes.includes("mlflow"),
  );
  const [resourceScope, setResourceScope] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAuthStatus()
      .then((status) => {
        if (cancelled) return;
        setResourceScope(
          status.enabled && status.authenticated ? (status.email?.trim().toLowerCase() ?? "") : "",
        );
      })
      .catch(() => {
        if (!cancelled) setResourceScope("");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const persistenceReady = resourceScope !== null;
  const threadKey = persistenceReady
    ? threadStorageKey(mastraClient.basePath, agentId, resourceScope || undefined)
    : undefined;
  const activeRunsKey = activeRunStorageKey(
    mastraClient.basePath,
    agentId,
    persistenceReady ? resourceScope || undefined : "pending",
  );
  const requestedThreadId = options.threadId?.trim() || undefined;
  const localThreadIdsRef = useRef(new Set<string>());
  const emittedThreadIdRef = useRef<string | undefined>(undefined);
  const threadIdChangeRef = useRef(options.onThreadIdChange);
  threadIdChangeRef.current = options.onThreadIdChange;
  const [activeThreadId, setActiveThreadId] = useState<string>(() => {
    const id = requestedThreadId ?? hash.id();
    if (!requestedThreadId) localThreadIdsRef.current.add(id);
    return id;
  });
  const mintThreadId = useCallback(() => {
    const id = hash.id();
    localThreadIdsRef.current.add(id);
    return id;
  }, []);
  const activateThread = useCallback((threadId: string, reason: ThreadIdChangeReason) => {
    emittedThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
    threadIdChangeRef.current?.(threadId, reason);
  }, []);
  const initializedThreadKeyRef = useRef<string | undefined>(undefined);
  const [hydratedThreadKey, setHydratedThreadKey] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!enableThreads || !threadKey || initializedThreadKeyRef.current === threadKey) return;
    initializedThreadKeyRef.current = threadKey;
    const storedThreadId = readStoredThreadId(threadKey);
    const threadId = requestedThreadId ?? storedThreadId ?? mintThreadId();
    setActiveThreadId(threadId);
    threadIdChangeRef.current?.(threadId, "hydrate");
    setHydratedThreadKey(threadKey);
  }, [enableThreads, mintThreadId, requestedThreadId, threadKey]);
  useEffect(() => {
    if (
      enableThreads &&
      hydratedThreadKey === threadKey &&
      requestedThreadId &&
      requestedThreadId !== activeThreadId
    ) {
      if (emittedThreadIdRef.current === activeThreadId) return;
      setActiveThreadId(requestedThreadId);
    } else if (requestedThreadId === activeThreadId) {
      emittedThreadIdRef.current = undefined;
    }
  }, [activeThreadId, enableThreads, hydratedThreadKey, requestedThreadId, threadKey]);
  const {
    threads,
    loading: isLoadingThreads,
    error: threadsError,
    refresh: refreshThreads,
    sync: syncThreads,
  } = useMastraThreads(options.agentId, enableThreads, genieClient);
  // Persist the active thread id so a reload reopens the same
  // conversation. Best-effort; storage may be unavailable.
  useEffect(() => {
    if (enableThreads && threadKey && hydratedThreadKey === threadKey && activeThreadId) {
      storeStoredThreadId(threadKey, activeThreadId);
    }
  }, [enableThreads, threadKey, hydratedThreadKey, activeThreadId]);
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
  // Threads the user just deleted. The server list can lag, so hide them
  // immediately and drop the overlay once the listing no longer returns them.
  const [removedThreadIds, setRemovedThreadIds] = useState<ReadonlySet<string>>(() => new Set());
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
  const {
    defaultModel: defaultModelName,
    defaultModelId,
    loading: defaultModelLoading,
  } = useMastraDefaultModel(agentId, showModelPicker);
  const selectedModel = controlledModel ?? model;
  const activeModel = selectedModel || defaultModelId || undefined;
  const activeModelOption = models.find((option) => option.name === activeModel);
  const reasoningEfforts = activeModelOption?.reasoningEfforts ?? EMPTY_REASONING_EFFORTS;
  const reasoningDefault = defaultReasoningEffort(reasoningEfforts);
  const reasoningModelKey = `${activeModel ?? ""}:${reasoningEfforts.join(",")}`;
  const initializedReasoningModelRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initializedReasoningModelRef.current === reasoningModelKey) return;
    initializedReasoningModelRef.current = reasoningModelKey;
    setReasoningEffort(reasoningDefault);
  }, [reasoningDefault, reasoningModelKey]);
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
    genieClient,
  );
  const suggestions = useMemo(
    () => explicitSuggestions ?? dedupeSuggestions(genieSuggestions),
    [explicitSuggestions, genieSuggestions],
  );
  const {
    activeKey,
    activeSession,
    getSession,
    moveSession,
    removeSession,
    resetSession,
    streamingThreadIds,
    updateSession,
    writeMessages,
  } = useChatSessions(activeThreadId);
  const browserTranscriptKey =
    browserPersistence && persistenceReady
      ? browserTranscriptStorageKey(
          mastraClient.basePath,
          agentId,
          activeKey,
          resourceScope || undefined,
        )
      : undefined;
  const [hydratedBrowserTranscriptKey, setHydratedBrowserTranscriptKey] = useState<string>();
  useEffect(() => {
    setHydratedBrowserTranscriptKey(undefined);
    if (!browserTranscriptKey) return;
    const stored = readStoredBrowserTranscript(browserTranscriptKey);
    if (stored.length > 0 && getSession(activeKey).messages.length === 0) {
      writeMessages(activeKey, stored);
    }
    setHydratedBrowserTranscriptKey(browserTranscriptKey);
  }, [activeKey, browserTranscriptKey, getSession, writeMessages]);
  useEffect(() => {
    if (!browserTranscriptKey || hydratedBrowserTranscriptKey !== browserTranscriptKey) {
      return;
    }
    storeBrowserTranscript(
      browserTranscriptKey,
      activeSession.messages,
      browserPersistence?.maxMessages,
    );
  }, [
    activeSession.messages,
    browserPersistence?.maxMessages,
    browserTranscriptKey,
    hydratedBrowserTranscriptKey,
  ]);
  useEffect(() => {
    if (
      !enableThreads ||
      hydratedThreadKey !== threadKey ||
      !requestedThreadId ||
      activeThreadId !== requestedThreadId ||
      isLoadingThreads ||
      threadsError ||
      localThreadIdsRef.current.has(requestedThreadId) ||
      optimisticThreads[requestedThreadId] ||
      threads.some((thread) => thread.id === requestedThreadId) ||
      readStoredActiveRuns(activeRunsKey).some((run) => run.threadId === requestedThreadId)
    ) {
      return;
    }
    const replacement = mintThreadId();
    resetSession(replacement, true);
    activateThread(replacement, "missing");
  }, [
    activateThread,
    activeRunsKey,
    activeThreadId,
    enableThreads,
    hydratedThreadKey,
    isLoadingThreads,
    mintThreadId,
    optimisticThreads,
    requestedThreadId,
    resetSession,
    threadKey,
    threads,
    threadsError,
  ]);
  const historyAvailability = isLoadingThreads
    ? "loading"
    : threads.some((thread) => thread.id === activeThreadId) || optimisticThreads[activeThreadId]
      ? "present"
      : "missing";
  const { isLoadingHistory, isLoadingMore, loadOlderHistory } = useChatHistory({
    activeKey,
    activeThreadId,
    agentId,
    availability: historyAvailability,
    getSession,
    mastraClient,
    updateSession,
    writeMessages,
  });
  const submitFeedback = useChatFeedback({
    activeKey,
    feedbackByMessage: activeSession.feedbackByMessage,
    feedbackModes,
    mastraClient,
    updateSession,
  });
  // Drains the next queued steer when a turn ends. Held in a ref because it
  // closes over `runStream`, which is defined below and itself calls
  // `driveStream` (which invokes this) - the ref breaks that cycle without a
  // stale-closure hazard (assigned each render, same pattern as `loadMoreRef`).
  const drainQueueRef = useRef<(threadId: string) => void>(() => {});
  const streamSettlementsRef = useRef(new Map<string, Promise<void>>());
  const adoptedThreadIdsRef = useRef(new Map<string, string>());

  const resolveThreadId = useCallback((threadId: string): string => {
    let resolved = threadId;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = adoptedThreadIdsRef.current.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }, []);

  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // Adopt the server-assigned id of a thread that streamed under a local id
  // (a new Genie conversation): move its session and sidebar overlays, then
  // switch to it when it is still the active thread.
  const adoptThreadId = useCallback(
    (localId: string, assignedId: string) => {
      adoptedThreadIdsRef.current.set(localId, assignedId);
      const settlement = streamSettlementsRef.current.get(localId);
      if (settlement) {
        streamSettlementsRef.current.delete(localId);
        streamSettlementsRef.current.set(assignedId, settlement);
      }
      moveSession(localId, assignedId);
      localThreadIdsRef.current.delete(localId);
      localThreadIdsRef.current.add(assignedId);
      setOptimisticThreads((prev) => {
        const row = prev[localId];
        if (!row) return prev;
        const { [localId]: _drop, ...rest } = prev;
        return { ...rest, [assignedId]: { ...row, id: assignedId } };
      });
      setProvisionalTitles((prev) => {
        const title = prev[localId];
        if (title === undefined) return prev;
        const { [localId]: _drop, ...rest } = prev;
        return { ...rest, [assignedId]: title };
      });
      if (activeThreadIdRef.current === localId) activateThread(assignedId, "resolve");
    },
    [activateThread, moveSession],
  );

  const processStream = useChatStream({
    getSession,
    onModelRoute: handleModelRoute,
    onModelUsage: handleModelUsage,
    updateSession,
    writeMessages,
  });
  const driveStream = useCallback(
    async (
      threadId: string,
      assistantId: string,
      open: (signal: AbortSignal) => Promise<MastraStreamResponse>,
    ) => {
      const turnStartedAt = new Date().toISOString();
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
        };
      });
      const runIdRef = { current: getSession(threadId).runId };
      // The session's key; changes when the server assigns the thread its id.
      let sessionThreadId = threadId;
      let openedStream: MastraStreamResponse | undefined;
      let streamedTitle: string | undefined;
      const adoptAssignedThreadId = () => {
        const assigned = openedStream?.threadId?.();
        if (!assigned || assigned === sessionThreadId) return;
        adoptThreadId(sessionThreadId, assigned);
        sessionThreadId = assigned;
      };
      try {
        try {
          openedStream = await open(controller.signal);
          streamedTitle = await processStream(
            threadId,
            openedStream,
            assistantId,
            runIdRef,
            controller.signal,
            turnStartedAt,
          );
          adoptAssignedThreadId();
        } catch (initialError) {
          const runId = runIdRef.current;
          if (
            controller.signal.aborted ||
            getSession(threadId).runToken !== token ||
            getSession(threadId).status === "error" ||
            initialError instanceof MastraChatRequestError ||
            !mastraClient.backgroundTurns ||
            !runId
          ) {
            throw initialError;
          }
          logger.warn("chat stream disconnected; reconnecting to background run", {
            runId,
            error: toError(initialError),
          });
          const messagesBeforeReplay = getSession(threadId).messages;
          writeMessages(
            threadId,
            messagesBeforeReplay.filter((message) => message.id !== assistantId),
          );
          const streamThreadId = threadId === DEFAULT_THREAD_SESSION_KEY ? undefined : threadId;
          try {
            const stream = await mastraClient.observeAgentStream({
              agentId,
              runId,
              threadId: streamThreadId,
              signal: controller.signal,
            });
            streamedTitle = await processStream(
              threadId,
              stream,
              assistantId,
              runIdRef,
              controller.signal,
              turnStartedAt,
            );
          } catch (reconnectError) {
            writeMessages(threadId, messagesBeforeReplay);
            throw reconnectError;
          }
        }
        if (streamedTitle) {
          const title = streamedTitle;
          setProvisionalTitles((prev) => ({ ...prev, [sessionThreadId]: title }));
          setOptimisticThreads((prev) =>
            prev[sessionThreadId]
              ? {
                  ...prev,
                  [sessionThreadId]: {
                    ...prev[sessionThreadId],
                    title,
                  },
                }
              : prev,
          );
        }
        if (enableThreads) {
          const synchronized = await syncThreads();
          const generatedTitle = synchronized
            .find((thread) => thread.id === sessionThreadId)
            ?.title?.trim();
          if (generatedTitle) {
            setProvisionalTitles((prev) => ({
              ...prev,
              [sessionThreadId]: generatedTitle,
            }));
            setOptimisticThreads((prev) =>
              prev[sessionThreadId]
                ? {
                    ...prev,
                    [sessionThreadId]: {
                      ...prev[sessionThreadId],
                      title: generatedTitle,
                    },
                  }
                : prev,
            );
          }
        }
        updateSession(sessionThreadId, (session) => {
          if (session.runToken !== token) return session;
          return {
            ...session,
            status: "ready",
            abortController:
              session.abortController === controller ? null : session.abortController,
            runId: runIdRef.current,
          };
        });
        if (getSession(sessionThreadId).runToken === token) {
          const completedRunId = runIdRef.current;
          if (completedRunId) removeStoredActiveRun(activeRunsKey, completedRunId);
          // Turn finished on its own: start the oldest queued steer, if any.
          drainQueueRef.current(sessionThreadId);
        }
      } catch (caught) {
        // A failed turn may still have created its server-side thread.
        adoptAssignedThreadId();
        const threadId = sessionThreadId;
        if (getSession(threadId).runToken !== token) return;
        if (isStaleMastraResumeError(caught)) {
          logger.warn("ignored stale mastra resume", {
            error: toError(caught),
          });
          updateSession(threadId, (session) => {
            if (session.runToken !== token) return session;
            return {
              ...session,
              error: null,
              status: "ready",
              abortController:
                session.abortController === controller ? null : session.abortController,
              runId: runIdRef.current,
            };
          });
          const staleRunId = runIdRef.current;
          if (staleRunId) removeStoredActiveRun(activeRunsKey, staleRunId);
          refreshThreadsSoon();
          drainQueueRef.current(threadId);
          return;
        }
        logger.error("stream error", {
          error: toError(caught),
        });
        updateSession(threadId, (session) => ({
          ...session,
          error: toError(caught),
          status: "error",
          abortController: session.abortController === controller ? null : session.abortController,
          runId: runIdRef.current,
        }));
        const failedRunId = runIdRef.current;
        if (failedRunId) removeStoredActiveRun(activeRunsKey, failedRunId);
      }
    },
    [
      adoptThreadId,
      agentId,
      activeRunsKey,
      enableThreads,
      getSession,
      mastraClient,
      processStream,
      refreshThreadsSoon,
      syncThreads,
      updateSession,
      writeMessages,
    ],
  );

  const runStream = useCallback(
    (threadId: string, messages: UIMessage | UIMessage[], requestContext?: RequestContext) => {
      const turnMessages = Array.isArray(messages) ? messages : [messages];
      const userMessage = lastUserMessage(turnMessages);
      if (!userMessage) throw new Error("A Mastra chat turn requires a user message");
      const assistantId = hash.id();
      const runId = hash.id();
      if (mastraClient.backgroundTurns) {
        storeActiveRun(activeRunsKey, {
          threadId,
          runId,
          assistantId,
          userMessage,
          startedAt: Date.now(),
        });
      }
      updateSession(threadId, (session) => ({
        ...session,
        assistantId,
        runId,
        runRequestContext: requestContext,
        lastRequestContext: requestContext,
        runs: {
          ...session.runs,
          [runId]: {
            assistantId,
            ...(requestContext ? { requestContext } : {}),
          },
        },
      }));
      // Capture this run's thread + model at send time and pass them per
      // call, so a run keeps its own routing even if the user switches
      // threads or changes the model picker while it streams.
      const streamThreadId = threadId === DEFAULT_THREAD_SESSION_KEY ? undefined : threadId;
      const model = modelRef.current || undefined;
      const turnReasoningEffort = reasoningEffortRef.current;
      const settlement = driveStream(threadId, assistantId, (signal) => {
        return mastraClient.streamAgent({
          agentId,
          messages: turnMessages,
          runId,
          threadId: streamThreadId,
          model,
          aiDecideStrategy: aiDecideStrategyRef.current,
          reasoningEffort: turnReasoningEffort,
          requestContext,
          signal,
        });
      });
      streamSettlementsRef.current.set(threadId, settlement);
      const clearSettlement = () => {
        for (const [settlementThreadId, current] of streamSettlementsRef.current) {
          if (current === settlement) streamSettlementsRef.current.delete(settlementThreadId);
        }
      };
      void settlement.then(clearSettlement, clearSettlement);
      return settlement;
    },
    [activeRunsKey, driveStream, mastraClient, agentId, updateSession],
  );

  const recoveredRunsKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!persistenceReady || mastraClient.backgroundTurns) return;
    for (const run of readStoredActiveRuns(activeRunsKey)) {
      removeStoredActiveRun(activeRunsKey, run.runId);
    }
  }, [activeRunsKey, mastraClient.backgroundTurns, persistenceReady]);
  useEffect(() => {
    if (
      !persistenceReady ||
      !mastraClient.backgroundTurns ||
      recoveredRunsKeyRef.current === activeRunsKey
    ) {
      return;
    }
    recoveredRunsKeyRef.current = activeRunsKey;
    for (const run of readStoredActiveRuns(activeRunsKey)) {
      const session = getSession(run.threadId);
      if (isSessionRunning(session) || session.runId === run.runId) continue;
      updateSession(run.threadId, (current) => ({
        ...current,
        messages: current.messages.some((message) => message.id === run.userMessage.id)
          ? current.messages
          : [...current.messages, run.userMessage],
        assistantId: run.assistantId,
        runId: run.runId,
        runs: {
          ...current.runs,
          [run.runId]: { assistantId: run.assistantId },
        },
      }));
      void driveStream(run.threadId, run.assistantId, (signal) =>
        mastraClient.observeAgentStream({
          agentId,
          runId: run.runId,
          threadId: run.threadId === DEFAULT_THREAD_SESSION_KEY ? undefined : run.threadId,
          signal,
        }),
      ).then(async () => {
        if (run.threadId === DEFAULT_THREAD_SESSION_KEY) return;
        const history = await mastraClient
          .history({
            agentId,
            threadId: run.threadId,
            page: 0,
            perPage: 20,
          })
          .catch(() => undefined);
        if (history) writeMessages(run.threadId, toChronologicalUiMessages(history));
      });
    }
  }, [
    activeRunsKey,
    agentId,
    driveStream,
    getSession,
    mastraClient,
    persistenceReady,
    updateSession,
    writeMessages,
  ]);

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
    const { message, next } = appendUserMessage(threadId, head.text ?? "", head.files);
    void runStream(
      threadId,
      conversationRequestMessages(conversationHistory, next, message),
      head.requestContext,
    );
  };

  // Cancel a thread's in-flight run. Defaults to the active thread (the
  // composer stop button), but takes an explicit thread id so the sidebar
  // can cancel a background thread without switching to it. Aborting one
  // thread's controller leaves every other run streaming - each run owns
  // its own controller and routing.
  const stop = useCallback(
    (threadId?: string) => {
      const key = threadId ?? activeKey;
      const current = getSession(key);
      if (!isSessionRunning(current)) return;
      const streamThreadId = key === DEFAULT_THREAD_SESSION_KEY ? undefined : key;
      if (mastraClient.backgroundTurns && current.runId) {
        void mastraClient
          .abortAgentRun({
            agentId,
            runId: current.runId,
            threadId: streamThreadId,
          })
          .then((aborted) => {
            if (aborted && current.runId) removeStoredActiveRun(activeRunsKey, current.runId);
          })
          .catch((error: unknown) => {
            logger.warn("failed to abort background run", {
              runId: current.runId,
              error: toError(error),
            });
          });
      }
      current.abortController?.abort();
      updateSession(key, (session) => {
        if (!isSessionRunning(session)) return session;
        return {
          ...session,
          abortController: null,
          runToken: session.runToken + 1,
          error: null,
          status: "ready",
        };
      });
    },
    [activeKey, activeRunsKey, agentId, getSession, mastraClient, updateSession],
  );

  const handleApproval = useChatApprovals({
    activeKey,
    agentId,
    driveStream,
    getSession,
    mastraClient,
    updateSession,
  });

  /** Abort the active run and wait until its durable stream reaches a terminal event. */
  const interruptActiveRun = useCallback(
    async (threadId: string): Promise<void> => {
      const current = getSession(threadId);
      if (!isSessionRunning(current)) return;
      const localSettlement = streamSettlementsRef.current.get(threadId);
      const streamThreadId = threadId === DEFAULT_THREAD_SESSION_KEY ? undefined : threadId;
      const runId = current.runId;
      const settlementSignal = AbortSignal.timeout(STEER_INTERRUPT_SETTLEMENT_TIMEOUT_MS);
      const settlementTimeout = new Promise<void>((resolve) => {
        if (settlementSignal.aborted) resolve();
        else settlementSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      const settlement =
        mastraClient.backgroundTurns && runId
          ? mastraClient
              .observeAgentStream({
                agentId,
                runId,
                threadId: streamThreadId,
                signal: settlementSignal,
              })
              .then((stream) => waitForTerminalChunk(stream.stream))
              .catch((error: unknown) => {
                if (settlementSignal.aborted) {
                  logger.warn("interrupted background run did not settle before replacement", {
                    runId,
                  });
                  return;
                }
                logger.warn("failed to observe interrupted background run", {
                  runId,
                  error: toError(error),
                });
              })
          : undefined;
      const serverAbort =
        mastraClient.backgroundTurns && runId
          ? mastraClient
              .abortAgentRun({ agentId, runId, threadId: streamThreadId })
              .then((aborted) => {
                if (aborted) removeStoredActiveRun(activeRunsKey, runId);
              })
              .catch((error: unknown) => {
                logger.warn("failed to abort interrupted background run", {
                  runId,
                  error: toError(error),
                });
              })
          : undefined;
      current.abortController?.abort();
      updateSession(threadId, (session) => {
        if (!isSessionRunning(session)) return session;
        return {
          ...session,
          abortController: null,
          runToken: session.runToken + 1,
          error: null,
          status: "submitted",
        };
      });
      await serverAbort;
      await settlement;
      if (localSettlement) await Promise.race([localSettlement, settlementTimeout]);
    },
    [activeRunsKey, agentId, getSession, mastraClient, updateSession],
  );

  // Append a user message to a thread's transcript, update thread activity,
  // and derive a provisional title for a brand-new thread.
  const appendUserMessage = useCallback(
    (
      threadId: string,
      text: string,
      files: FileUIPart[] = [],
    ): { message: UIMessage; next: UIMessage[] } => {
      const session = getSession(threadId);
      const expectsTitle =
        enableThreads &&
        !threads.some((thread) => thread.id === threadId && Boolean(thread.title?.trim()));
      let provisionalTitle: string | undefined;
      if (activeThreadId) {
        noteThreadActivity(activeThreadId);
        if (expectsTitle) {
          provisionalTitle = deriveThreadTitle(
            text || files.map((file) => file.filename || "Image").join(", "),
          );
          if (provisionalTitle) {
            setProvisionalTitles((prev) =>
              prev[activeThreadId] ? prev : { ...prev, [activeThreadId]: provisionalTitle! },
            );
          }
        }
      }
      const message = makeUserMessage(text, files);
      const next = [...session.messages, message];
      writeMessages(threadId, next);
      return { message, next };
    },
    [activeThreadId, enableThreads, getSession, noteThreadActivity, threads, writeMessages],
  );

  // Send a message on the active thread. The default queues submissions made
  // during an active turn. Callers that disable queuing interrupt the active
  // run and immediately start the replacement instead.
  const sendMessage = useCallback<ChatViewProps["sendMessage"]>(
    (message) => {
      const text = message.text ?? "";
      const files = message.files ?? [];
      if (!text && files.length === 0) return;
      const threadId = activeKey;
      const requestContext = snapshotRequestContext(requestContextRef.current);
      const current = getSession(threadId);
      if (isSessionRunning(current)) {
        if (queueMessages) {
          updateSession(threadId, (session) => ({
            ...session,
            queuedSteers: enqueueSteer(session.queuedSteers, {
              id: hash.id(),
              text,
              ...(files.length > 0 ? { files } : {}),
              ...(requestContext ? { requestContext } : {}),
            }),
          }));
          return;
        }
        void (async () => {
          await interruptActiveRun(threadId);
          const replacementThreadId = resolveThreadId(threadId);
          const { message: replacement } = appendUserMessage(replacementThreadId, text, files);
          const replacementMessages =
            conversationHistory === "browser"
              ? conversationRequestMessages(
                  conversationHistory,
                  current.messages,
                  replacement,
                  current.assistantId,
                )
              : interruptedTurnMessages(current.messages, replacement);
          void runStream(replacementThreadId, replacementMessages, requestContext);
        })();
        return;
      }
      const { message: userMessage, next } = appendUserMessage(threadId, text, files);
      void runStream(
        threadId,
        conversationRequestMessages(conversationHistory, next, userMessage),
        requestContext,
      );
    },
    [
      activeKey,
      appendUserMessage,
      getSession,
      interruptActiveRun,
      queueMessages,
      resolveThreadId,
      runStream,
      conversationHistory,
      updateSession,
    ],
  );

  // Fire a queued steer immediately, out of order. Wait for the interrupted
  // stream to publish and adopt any server-assigned thread id before appending
  // the replacement turn; otherwise a new direct Genie conversation can start
  // under the stale local thread id.
  const sendSteerNow = useCallback(
    (steerId: string) => {
      const threadId = activeKey;
      const current = getSession(threadId);
      const steer = current.queuedSteers.find((s) => s.id === steerId);
      if (!steer) return;
      updateSession(threadId, (session) => ({
        ...session,
        queuedSteers: removeSteerFromQueue(session.queuedSteers, steerId),
      }));
      logger.info("steer:send-now", { threadId });
      void (async () => {
        await interruptActiveRun(threadId);
        const replacementThreadId = resolveThreadId(threadId);
        const { message } = appendUserMessage(replacementThreadId, steer.text ?? "", steer.files);
        const replacementMessages =
          conversationHistory === "browser"
            ? conversationRequestMessages(
                conversationHistory,
                current.messages,
                message,
                current.assistantId,
              )
            : interruptedTurnMessages(current.messages, message);
        void runStream(replacementThreadId, replacementMessages, steer.requestContext);
      })();
    },
    [
      activeKey,
      appendUserMessage,
      getSession,
      interruptActiveRun,
      resolveThreadId,
      runStream,
      conversationHistory,
      updateSession,
    ],
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
   * client-side state that mirrored it. The next turn recreates the
   * same client-owned thread id without a reload.
   */
  const handleClear = useCallback(async () => {
    const threadId = activeKey;
    try {
      await mastraClient.clearHistory({ agentId, threadId: activeThreadId });
      logger.info("history cleared", { threadId });
    } catch (error) {
      logger.error("history clear error", {
        error: toError(error),
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
      activateThread(threadId, "select");
    },
    [activateThread, activeThreadId],
  );

  const newThread = useCallback(() => {
    const id = mintThreadId();
    resetSession(id, true);
    activateThread(id, "new");
  }, [activateThread, mintThreadId, resetSession]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      setRemovedThreadIds((prev) => new Set(prev).add(threadId));
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
        const id = mintThreadId();
        resetSession(id, true);
        activateThread(id, "delete");
      }
      try {
        await mastraClient.removeThread(threadId, { agentId });
        logger.info("thread deleted", { threadId });
        refreshThreads();
      } catch (error) {
        logger.error("thread delete error", {
          threadId,
          error: toError(error),
        });
        setRemovedThreadIds((prev) => {
          if (!prev.has(threadId)) return prev;
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
    },
    [
      activateThread,
      activeThreadId,
      agentId,
      mastraClient,
      mintThreadId,
      refreshThreads,
      removeSession,
      resetSession,
    ],
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
          error: toError(error),
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
    const prev = getSession(threadId).messages;
    const lastAssistant = prev.length > 0 && prev.at(-1)?.role === "assistant" ? prev.at(-1) : null;
    const trimmed = lastAssistant ? prev.slice(0, -1) : prev;
    const lastUser = [...trimmed].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    if (lastAssistant) {
      updateSession(threadId, (session) => {
        const { [lastAssistant.id]: _approvals, ...pendingApprovals } =
          session.pendingApprovalsByMessage;
        const { [lastAssistant.id]: _feedback, ...feedback } = session.feedbackByMessage;
        return {
          ...session,
          pendingApprovalsByMessage: pendingApprovals,
          feedbackByMessage: feedback,
        };
      });
    }
    void mastraClient
      .deleteMessages(activeThreadId, [lastUser.id, ...(lastAssistant ? [lastAssistant.id] : [])], {
        agentId,
      })
      .then(() => {
        writeMessages(threadId, trimmed);
        void runStream(
          threadId,
          conversationRequestMessages(conversationHistory, trimmed, lastUser),
          getSession(threadId).lastRequestContext,
        );
      })
      .catch((error: unknown) => {
        logger.error("regenerate cleanup error", {
          threadId,
          error: toError(error),
        });
        updateSession(threadId, (session) => ({
          ...session,
          error: toError(error),
          status: "error",
        }));
      });
  }, [
    activeKey,
    activeThreadId,
    agentId,
    getSession,
    mastraClient,
    runStream,
    conversationHistory,
    updateSession,
    writeMessages,
  ]);

  // Chat export (opt-in). Resolves `[chart:<id>]` / `[data:<id>]` embeds
  // straight off the client so the export inlines the same charts /
  // tables the UI renders. Handlers are defined unconditionally (rules of
  // hooks) and only surfaced to ChatView when `enableExport` is on.
  const exportResolver = useMemo<EmbedResolver>(
    () => ({
      chart: (id) => mastraClient.chart(id),
      statement: (id) => mastraClient.statement(id),
      visualization: (id) => mastraClient.visualization(id),
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
          error: toError(error),
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
          error: toError(error),
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
    return [...pending, ...server].filter((thread) => !removedThreadIds.has(thread.id));
  }, [threads, optimisticThreads, renamedThreads, provisionalTitles, removedThreadIds]);
  // Once the server list includes a thread we were tracking optimistically,
  // drop the optimistic copy so the map doesn't grow without bound.
  useEffect(() => {
    if (removedThreadIds.size === 0) return;
    const serverIds = new Set(threads.map((t) => t.id));
    const settled = [...removedThreadIds].filter((id) => !serverIds.has(id));
    if (settled.length === 0) return;
    setRemovedThreadIds((prev) => {
      const next = new Set(prev);
      for (const id of settled) next.delete(id);
      return next;
    });
  }, [threads, removedThreadIds]);
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
    followUpSuggestions: mastraClient.followUpSuggestions,
    followUpSuggestionLimit: mastraClient.followUpSuggestionLimit,
    pendingApprovalsByMessage: activeSession.pendingApprovalsByMessage,
    onResolveToolApproval: handleApproval,
    // Picker is opt-in: only hand ChatView the catalogue + change
    // handler when `showModelPicker` is on, otherwise the header hides
    // it (ChatView shows it only when both are present).
    models: showModelPicker ? models : undefined,
    model: selectedModel,
    onModelChange: showModelPicker ? handleModelChange : undefined,
    reasoningEffort,
    onReasoningEffortChange: showModelPicker ? setReasoningEffort : undefined,
    defaultModelName: showModelPicker ? (defaultModelName ?? undefined) : undefined,
    defaultModelId: showModelPicker ? (defaultModelId ?? undefined) : undefined,
    defaultModelLoading: showModelPicker && defaultModelLoading,
    onLoadMore: loadOlderHistory,
    isLoadingMore,
    hasMore: activeSession.hasMoreHistory,
    isLoadingHistory:
      !persistenceReady ||
      isLoadingHistory ||
      Boolean(browserTranscriptKey && hydratedBrowserTranscriptKey !== browserTranscriptKey),
    browserPersistenceHydrated:
      !browserPersistence ||
      Boolean(
        persistenceReady &&
        browserTranscriptKey &&
        hydratedBrowserTranscriptKey === browserTranscriptKey,
      ),
    ...(mastraClient.attachments ? {} : { allowAttachments: false }),
    ...(enableClear ? { onClear: handleClear } : {}),
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
          ...(mastraClient.threadRename ? { onRenameThread: renameThread } : {}),
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
    // Feedback: choose per message. Genie results use their message identity;
    // other responses require an MLflow trace id.
    ...(feedbackAvailable
      ? {
          feedbackModes: [...feedbackModes],
          feedbackByMessage: activeSession.feedbackByMessage,
          onFeedback: submitFeedback,
          ...(mlflowExperimentUrl ? { mlflowExperimentUrl } : {}),
          ...(mlflowTracePrefix ? { mlflowTracePrefix } : {}),
        }
      : {}),
  };
};

/** Props for {@link MastraChat}. */
export interface MastraChatProps<
  TValues extends Record<string, unknown> = Record<string, unknown>,
> extends UseMastraChatOptions<TValues> {
  /** Extra classes merged onto the chat's root layout container. */
  className?: string;
  /** Host controls placed beside the model picker in the composer footer. */
  composerActions?: ReactNode;
  /** Host controls shown inside the model selector after its endpoint choices. */
  modelSelectorActions?: ReactNode;
  /** Host controls placed on the left side of the composer footer. */
  composerLeadingActions?: ReactNode;
  /** Host controls rendered immediately before the responsive History action. */
  threadHistoryLeadingActions?: ReactNode;
  /** Host controls rendered in the full conversation-list header. */
  threadSidebarHeaderActions?: ReactNode;
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
 * `threadPlacement` (`auto` docks it right and falls back to a tab strip on a
 * narrow chat) and turned off with `threadPlacement: "disabled"`.
 */
export const MastraChat = <TValues extends Record<string, unknown> = Record<string, unknown>>({
  className,
  composerActions,
  modelSelectorActions,
  composerLeadingActions,
  threadHistoryLeadingActions,
  threadSidebarHeaderActions,
  ...options
}: MastraChatProps<TValues>) => {
  const chat = useMastraChat(options);
  return (
    <ChatView
      {...chat}
      className={className}
      composerActions={composerActions}
      modelSelectorActions={modelSelectorActions}
      composerLeadingActions={composerLeadingActions}
      threadHistoryLeadingActions={threadHistoryLeadingActions}
      threadSidebarHeaderActions={threadSidebarHeaderActions}
    />
  );
};
