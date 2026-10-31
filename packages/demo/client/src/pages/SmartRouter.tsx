import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@databricks/appkit-ui/react";
import { getAuthStatus } from "@dbx-tools/shared-auth";
import {
  MODEL_ROUTE_PART_TYPE,
  MODEL_USAGE_PART_TYPE,
  ModelRoutePartDataSchema,
  ModelUsagePartDataSchema,
  type ModelRoutePartData,
  type ModelUsagePartData,
} from "@dbx-tools/shared-mastra";
import {
  ChatComposer,
  ChatView,
  isActiveChatStatus,
  isRespondingChatStatus,
  SuggestionPills,
  type ChatModelOption,
  type ChatStatus,
  useMastraChat,
} from "@dbx-tools/ui-mastra/react";
import {
  readBrowserMessageTimestamps,
  useMastraClient,
  useMastraModels,
} from "@dbx-tools/ui-mastra/support";
import {
  LoaderCircleIcon,
  PlusIcon,
  RouteIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

const SMART_ROUTER_MODEL = "smart-router";
const AI_DECIDE_MODEL = "ai-decide";
const GENIE_VALUE = "__genie__";
const FALLBACK_SUGGESTIONS = [
  "Explain idempotency in API retries in two concise sentences.",
  "Compare optimistic and pessimistic locking, including when you would choose each.",
  "Design a zero-downtime plan to extract authentication from a TypeScript monolith, including rollout, rollback, observability, and data migration.",
] as const;
const SUGGESTION_REQUESTS = [
  {
    request: "One simple follow-up grounded in the conversation",
    instructions:
      "Generate exactly one simple, focused next message grounded in the supplied conversation context. It should be answerable well by a small fast model.",
  },
  {
    request: "One moderately complex follow-up grounded in the conversation",
    instructions:
      "Generate exactly one moderately complex next message grounded in the supplied conversation context. Prefer a useful comparison, implication, or tradeoff.",
  },
  {
    request: "One complex follow-up grounded in the conversation",
    instructions:
      "Generate exactly one complex next message grounded in the supplied conversation context. Prefer design, planning, synthesis, or multi-constraint reasoning.",
  },
] as const;
const SUGGESTION_INSTRUCTION_SUFFIX = [
  "Write the item in the user's voice as a self-contained message that can be sent immediately.",
  "Do not mention models, routing, difficulty, complexity, or these instructions.",
  "Do not add a label or number.",
].join(" ");

const PaneDescriptorSchema = z
  .object({
    id: z.string().min(1).describe("Stable comparison-pane identifier."),
    threadId: z.string().min(1).describe("Stable browser-persisted chat thread identifier."),
    kind: z.enum(["mastra", "genie"]).describe("Comparison chat transport."),
    title: z.string().min(1).describe("Visible comparison-pane title."),
    initialModel: z.string().min(1).optional().describe("Initial Mastra model override."),
  })
  .strict()
  .describe("Browser-persisted Models demo chat pane.");

type PaneDescriptor = z.infer<typeof PaneDescriptorSchema>;

const StoredPanesSchema = z
  .object({
    version: z.literal(1).describe("Models demo pane storage format version."),
    panes: z.array(PaneDescriptorSchema).describe("Ordered model comparison panes."),
  })
  .strict()
  .describe("Browser-persisted Models demo layout.");

const PANES_STORAGE_KEY = "dbx-demo-model-panes";

function createPane(descriptor: Omit<PaneDescriptor, "id" | "threadId">): PaneDescriptor {
  return { ...descriptor, id: crypto.randomUUID(), threadId: crypto.randomUUID() };
}

function readStoredPanes(): PaneDescriptor[] | undefined {
  try {
    const serialized = window.localStorage.getItem(PANES_STORAGE_KEY);
    if (!serialized) return undefined;
    return StoredPanesSchema.parse(JSON.parse(serialized)).panes;
  } catch {
    try {
      window.localStorage.removeItem(PANES_STORAGE_KEY);
    } catch {}
    return undefined;
  }
}

function storePanes(panes: readonly PaneDescriptor[]): void {
  try {
    window.localStorage.setItem(
      PANES_STORAGE_KEY,
      JSON.stringify({ version: 1, panes }),
    );
  } catch {
    // Browser persistence is best-effort; the live comparison remains usable.
  }
}

type PaneController = {
  send: (text: string) => void;
  clear: () => Promise<void>;
  context: () => { title: string; messages: readonly ChatMessageLike[] };
};

type UsageMap = Record<string, ModelUsagePartData>;

function defaultPanes(
  models: readonly ChatModelOption[],
  genieAvailable: boolean,
  rankedModels: { gpt?: ChatModelOption; claude?: ChatModelOption },
): PaneDescriptor[] {
  const panes: PaneDescriptor[] = [];
  if (models.some((model) => model.name === SMART_ROUTER_MODEL)) {
    panes.push(createPane({
      kind: "mastra",
      title: "Smart Router",
      initialModel: SMART_ROUTER_MODEL,
    }));
  }
  if (models.some((model) => model.name === AI_DECIDE_MODEL)) {
    panes.push(createPane({
      kind: "mastra",
      title: "AI Decide",
      initialModel: AI_DECIDE_MODEL,
    }));
  }
  if (rankedModels.gpt) {
    panes.push(createPane({
      kind: "mastra",
      title: "OpenAI",
      initialModel: rankedModels.gpt.name,
    }));
  }
  if (rankedModels.claude) {
    panes.push(createPane({
      kind: "mastra",
      title: "Anthropic",
      initialModel: rankedModels.claude.name,
    }));
  }
  if (genieAvailable) {
    panes.push(createPane({ kind: "genie", title: "Genie only" }));
  }
  return panes;
}

const SmartRouter = () => {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(true);
  const [panes, setPanes] = useState<PaneDescriptor[]>([]);
  const [panesInitialized, setPanesInitialized] = useState(false);
  const [genieAvailable, setGenieAvailable] = useState<boolean>();
  const [rankedModels, setRankedModels] = useState<{
    gpt?: ChatModelOption;
    claude?: ChatModelOption;
  }>();
  const [statuses, setStatuses] = useState<Record<string, ChatStatus>>({});
  const [clearArmed, setClearArmed] = useState(false);
  const controllers = useRef(new Map<string, PaneController>());
  const recentPrompts = useRef<string[]>([]);
  const suggestionController = useRef<AbortController | undefined>(undefined);
  const restoredContextTimer = useRef<number | undefined>(undefined);
  const regenerateAfterResponse = useRef(false);
  const defaultsInitialized = useRef(false);
  const mastraClient = useMastraClient();
  const { models, loading: modelsLoading } = useMastraModels();

  const generateSuggestions = useCallback(
    (sentPrompt?: string) => {
      if (sentPrompt) {
        recentPrompts.current = [...recentPrompts.current, sentPrompt].slice(-8);
      }
      suggestionController.current?.abort();
      const controller = new AbortController();
      suggestionController.current = controller;
      setSuggestions([]);
      setSuggestionLoading(true);
      const conversations = [...controllers.current.values()]
        .map((pane) => pane.context())
        .filter(({ messages }) => messages.length > 0)
        .map(({ title, messages }) => ({ title, messages: messages.slice(-8) }));
      const hasConversationContext = conversations.length > 0 || Boolean(sentPrompt);
      const context = {
        purpose: "Continue the shared conversation with a useful next question.",
        ...(sentPrompt ? { latestUserMessage: sentPrompt } : {}),
        ...(conversations.length > 0 ? { conversations } : {}),
        recentUserMessages: recentPrompts.current,
        ...(!hasConversationContext ? { exampleQueries: FALLBACK_SUGGESTIONS } : {}),
      };
      void Promise.all(
        SUGGESTION_REQUESTS.map(({ request, instructions }) =>
          mastraClient.generateSuggestions(
            {
              context: { ...context, requestedQuestion: request },
              maxSuggestions: 1,
              maxTokens: 96,
              existingSuggestions: recentPrompts.current,
              instructions: `${instructions} ${SUGGESTION_INSTRUCTION_SUFFIX}`,
            },
            controller.signal,
          ),
        ),
      )
        .then((questionGroups) => {
          if (controller.signal.aborted) return;
          const questions = questionGroups.flat();
          const recent = new Set(recentPrompts.current.map((value) => value.trim().toLowerCase()));
          const fallback = hasConversationContext ? [] : FALLBACK_SUGGESTIONS;
          const unique = [...new Set([...questions, ...fallback])].filter(
            (question) => !recent.has(question.trim().toLowerCase()),
          );
          const candidates = unique.length > 0 ? unique : [...new Set([...questions, ...fallback])];
          setSuggestions(candidates.slice(0, 3));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setSuggestions(hasConversationContext ? [] : [...FALLBACK_SUGGESTIONS]);
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          suggestionController.current = undefined;
          setSuggestionLoading(false);
        });
    },
    [mastraClient],
  );

  useEffect(() => {
    generateSuggestions();
    return () => {
      suggestionController.current?.abort();
      if (restoredContextTimer.current !== undefined) {
        window.clearTimeout(restoredContextTimer.current);
      }
    };
  }, [generateSuggestions]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      mastraClient.resolveModel("gpt", controller.signal),
      mastraClient.resolveModel("claude", controller.signal),
    ])
      .then(([gpt, claude]) => {
        if (!controller.signal.aborted) setRankedModels({ gpt, claude });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRankedModels({});
      });
    return () => controller.abort();
  }, [mastraClient]);

  useEffect(() => {
    let cancelled = false;
    void getAuthStatus()
      .then((status) => {
        if (!cancelled) setGenieAvailable(!status.enabled);
      })
      .catch(() => {
        if (!cancelled) setGenieAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (
      defaultsInitialized.current ||
      modelsLoading ||
      genieAvailable === undefined ||
      rankedModels === undefined
    ) {
      return;
    }
    defaultsInitialized.current = true;
    const modelNames = new Set(models.map(({ name }) => name));
    const stored = readStoredPanes()?.filter((pane) =>
      pane.kind === "genie"
        ? genieAvailable
        : Boolean(pane.initialModel && modelNames.has(pane.initialModel)),
    );
    setPanes(stored ?? defaultPanes(models, genieAvailable, rankedModels));
    setPanesInitialized(true);
  }, [genieAvailable, models, modelsLoading, rankedModels]);
  useEffect(() => {
    if (panesInitialized) storePanes(panes);
  }, [panes, panesInitialized]);

  const registerPane = useCallback((id: string, controller?: PaneController) => {
    if (controller) controllers.current.set(id, controller);
    else controllers.current.delete(id);
  }, []);
  const reportStatus = useCallback((id: string, status?: ChatStatus) => {
    setStatuses((current) => {
      if (status === undefined) {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      if (current[id] === status) return current;
      return { ...current, [id]: status };
    });
  }, []);
  const running = panes.some((pane) => {
    const status = statuses[pane.id];
    return status ? isActiveChatStatus(status) : false;
  });
  useEffect(() => {
    if (running) {
      regenerateAfterResponse.current = true;
      return;
    }
    if (!regenerateAfterResponse.current) return;
    regenerateAfterResponse.current = false;
    generateSuggestions();
  }, [generateSuggestions, running]);
  const submit = (prompt: string) => {
    const text = prompt.trim();
    if (!text || panes.length === 0) return;
    setClearArmed(false);
    for (const pane of panes) controllers.current.get(pane.id)?.send(text);
    generateSuggestions(text);
  };
  const addPane = (value: string) => {
    if (value === GENIE_VALUE) {
      setPanes((current) => [
        ...current,
        createPane({ kind: "genie", title: "Genie only" }),
      ]);
      return;
    }
    const initialModel = value;
    const model = models.find((candidate) => candidate.name === initialModel);
    setPanes((current) => [
      ...current,
      createPane({
        kind: "mastra",
        title:
          initialModel === SMART_ROUTER_MODEL
            ? "Smart Router"
            : initialModel === AI_DECIDE_MODEL
              ? "AI Decide"
              : (model?.displayName ?? model?.name ?? "Mastra default"),
        initialModel,
      }),
    ]);
  };
  const closePane = (id: string) => {
    controllers.current.delete(id);
    setPanes((current) => current.filter((pane) => pane.id !== id));
    reportStatus(id, undefined);
  };
  const clearAll = () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setClearArmed(false);
    recentPrompts.current = [];
    generateSuggestions();
    void Promise.all([...controllers.current.values()].map((controller) => controller.clear()));
  };
  const refreshRestoredSuggestions = useCallback(() => {
    if (restoredContextTimer.current !== undefined) {
      window.clearTimeout(restoredContextTimer.current);
    }
    restoredContextTimer.current = window.setTimeout(() => {
      restoredContextTimer.current = undefined;
      generateSuggestions();
    }, 100);
  }, [generateSuggestions]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2 md:p-4">
      {panes.length > 0 ? (
        <div className="flex min-h-0 flex-1 snap-x snap-proximity scroll-px-2 gap-2 overflow-x-auto overscroll-x-contain pb-1 touch-pan-x [-webkit-overflow-scrolling:touch] md:scroll-px-3 md:gap-3">
          {panes.map((pane) => (
            <ModelChatPane
              key={pane.id}
              pane={pane}
              onClose={() => closePane(pane.id)}
              onRegister={registerPane}
              onStatusChange={reportStatus}
              onContextRestored={refreshRestoredSuggestions}
            />
          ))}
        </div>
      ) : panesInitialized ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
          Add a model or Genie chat to start comparing.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading available models...
        </div>
      )}

      <div className="group/composer shrink-0 border-t border-border/70 bg-background">
        <div className="mx-auto min-h-0 w-full max-w-4xl px-3 pt-2 group-focus-within/composer:hidden md:px-6">
          {suggestionLoading ? (
            <div className="flex h-7 items-center gap-2 px-1 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
              <span>Finding follow-ups...</span>
            </div>
          ) : (
            <SuggestionPills
              questions={suggestions}
              onSelect={submit}
              className="h-7 flex-nowrap overflow-x-auto md:flex-nowrap md:overflow-x-auto [&>button]:h-7 [&>button]:min-w-0 [&>button]:max-w-64 [&>button]:justify-start [&>button]:truncate [&>button]:border-border/70 [&>button]:bg-muted/30 [&>button]:px-2.5 [&>button]:py-0 [&>button]:text-[11px] [&>button]:leading-none"
            />
          )}
        </div>
        <ChatComposer
          focusRequest={0}
          status="ready"
          sendMessage={(message) => submit(message.text ?? "")}
          queuedSteers={[]}
          onSendSteerNow={undefined}
          onRemoveSteer={undefined}
          onReorderSteers={undefined}
          onStop={undefined}
          models={undefined}
          model={undefined}
          onModelChange={undefined}
          defaultModelName={undefined}
          defaultModelId={undefined}
          defaultModelLoading={false}
          reasoningEffort={undefined}
          onReasoningEffortChange={undefined}
          composerActions={undefined}
          modelSelectorActions={undefined}
          composerLeadingActions={
            <>
              <Select value="" onValueChange={addPane}>
                <SelectTrigger
                  className="size-7 shrink-0 rounded-full p-0 [&>svg:last-child]:hidden"
                  aria-label="Add model comparison"
                  title="Add model comparison"
                >
                  <PlusIcon className="size-3" aria-hidden />
                  <SelectValue placeholder="" />
                </SelectTrigger>
                <SelectContent>
                  {genieAvailable ? <SelectItem value={GENIE_VALUE}>Genie only</SelectItem> : null}
                  {models.map((model) => (
                    <SelectItem key={model.name} value={model.name}>
                      {model.displayName ?? model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant={clearArmed ? "destructive" : "outline"}
                size="icon"
                className="size-7 rounded-full [&_svg]:size-3"
                aria-label={clearArmed ? "Confirm clear all chats" : "Clear all chats"}
                title={clearArmed ? "Click again to clear all chats" : "Clear all chats"}
                disabled={running || panes.length === 0}
                onClick={clearAll}
              >
                <Trash2Icon />
              </Button>
            </>
          }
          allowAttachments={false}
          isLoadingHistory={false}
          onClear={undefined}
          onExportConversation={undefined}
          onResumeFollow={() => undefined}
        />
      </div>
    </div>
  );
};

const ModelChatPane = ({
  pane,
  onClose,
  onRegister,
  onStatusChange,
  onContextRestored,
}: {
  pane: PaneDescriptor;
  onClose: () => void;
  onRegister: (id: string, controller?: PaneController) => void;
  onStatusChange: (id: string, status?: ChatStatus) => void;
  onContextRestored: () => void;
}) => {
  const [metricScope, setMetricScope] = useState<"current" | "total">("current");
  const [usage, setUsage] = useState<UsageMap>({});
  const [requestUsage, setRequestUsage] = useState<ModelUsagePartData | undefined>();
  const [route, setRoute] = useState<ModelRoutePartData | undefined>();
  const [latencyMs, setLatencyMs] = useState<number | undefined>();
  const [totalTimeMs, setTotalTimeMs] = useState(0);
  const [timerNow, setTimerNow] = useState(() => performance.now());
  const startedAt = useRef<number | undefined>(undefined);
  const assistantTextBaseline = useRef(0);
  const finishTiming = useCallback(() => {
    if (startedAt.current === undefined) return;
    const elapsed = performance.now() - startedAt.current;
    setLatencyMs(elapsed);
    setTotalTimeMs((total) => total + elapsed);
    startedAt.current = undefined;
  }, []);
  const recordModelUsage = useCallback((item: ModelUsagePartData) => {
    setRequestUsage(item);
    setRoute(item);
    recordUsage(setUsage, item);
  }, []);
  const recordModelRoute = useCallback((item: ModelRoutePartData) => {
    setRoute(item);
  }, []);
  const chat = useMastraChat({
    ...(pane.kind === "genie"
      ? { genieSpace: "default" }
      : {
          agentId: "models",
          model: pane.initialModel,
          aiDecideStrategy: pane.initialModel === AI_DECIDE_MODEL ? "cost" : undefined,
          conversationHistory: "browser",
          onModelRoute: recordModelRoute,
          onModelUsage: recordModelUsage,
        }),
    showSelectedModel: true,
    enableClear: true,
    browserPersistence: true,
    queueMessages: false,
    suggestions: [],
    threadId: pane.threadId,
    threadPlacement: "disabled",
    requestContext: { route: "/smart-router", surface: pane.title },
  });
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  const restoredContextReported = useRef(false);
  const restoredMetricsApplied = useRef(false);

  useEffect(() => {
    if (!chat.browserPersistenceHydrated || restoredMetricsApplied.current) return;
    restoredMetricsApplied.current = true;
    const restored = conversationMetrics(chat.messages);
    setUsage(restored.usage);
    setRequestUsage(restored.requestUsage);
    setRoute(restored.route);
    setLatencyMs(restored.latencyMs);
    setTotalTimeMs(restored.totalTimeMs);
    if (!restoredContextReported.current && chat.messages.length > 0) {
      restoredContextReported.current = true;
      onContextRestored();
    }
  }, [chat.browserPersistenceHydrated, chat.messages, onContextRestored]);

  useEffect(() => {
    if (!isRespondingChatStatus(chat.status)) return;
    let frame = 0;
    const update = () => {
      setTimerNow(performance.now());
      frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [chat.status]);

  useEffect(() => {
    onStatusChange(pane.id, chat.status);
    if (!isRespondingChatStatus(chat.status)) finishTiming();
  }, [chat.status, finishTiming, onStatusChange, pane.id]);
  useEffect(() => {
    onRegister(pane.id, {
      send: (text) => {
        const now = performance.now();
        if (startedAt.current !== undefined) {
          const interruptedElapsed = now - startedAt.current;
          setLatencyMs(interruptedElapsed);
          setTotalTimeMs((total) => total + interruptedElapsed);
        }
        assistantTextBaseline.current = assistantTextLength(messagesRef.current);
        startedAt.current = now;
        setRequestUsage(undefined);
        if (pane.initialModel === SMART_ROUTER_MODEL || pane.initialModel === AI_DECIDE_MODEL) {
          setRoute(undefined);
        }
        chat.sendMessage({ text });
      },
      clear: async () => {
        startedAt.current = undefined;
        await chat.onClear?.();
        setUsage({});
        setRequestUsage(undefined);
        setRoute(undefined);
        setLatencyMs(undefined);
        setTotalTimeMs(0);
        setTimerNow(performance.now());
        assistantTextBaseline.current = 0;
      },
      context: () => ({ title: pane.title, messages: messagesRef.current }),
    });
    return () => {
      onRegister(pane.id, undefined);
      onStatusChange(pane.id, undefined);
    };
  }, [chat.onClear, chat.sendMessage, onRegister, onStatusChange, pane.id, pane.title]);

  const usageValues = Object.values(usage);
  const authoritativeTotalTokens = usageValues.reduce(
    (sum, item) => sum + item.usage.totalTokens,
    0,
  );
  const authoritativeTotalCost = usageValues.reduce(
    (sum, item) => sum + (item.estimatedCostDbu ?? 0),
    0,
  );
  const hasAuthoritativeCost = usageValues.some((item) => item.estimatedCostDbu !== undefined);
  const responding = isRespondingChatStatus(chat.status);
  const streamedOutputTokens = responding
    ? Math.ceil(Math.max(0, assistantTextLength(chat.messages) - assistantTextBaseline.current) / 4)
    : 0;
  const authoritativeRequestTokens = requestUsage?.usage.totalTokens ?? 0;
  const requestTokenTarget = requestUsage
    ? authoritativeRequestTokens +
      (responding ? Math.max(0, streamedOutputTokens - requestUsage.usage.outputTokens) : 0)
    : responding
      ? streamedOutputTokens
      : undefined;
  const requestCostEstimate = route?.pricing
    ? estimateRequestCost(route.pricing, {
        inputTokens: requestUsage?.usage.inputTokens ?? 0,
        outputTokens: responding
          ? Math.max(requestUsage?.usage.outputTokens ?? 0, streamedOutputTokens)
          : (requestUsage?.usage.outputTokens ?? 0),
        cachedInputTokens: requestUsage?.usage.cachedInputTokens ?? 0,
      })
    : undefined;
  const requestUsdEstimate = route?.pricing
    ? estimateRequestUsd(route.pricing, {
        inputTokens: requestUsage?.usage.inputTokens ?? 0,
        outputTokens: responding
          ? Math.max(requestUsage?.usage.outputTokens ?? 0, streamedOutputTokens)
          : (requestUsage?.usage.outputTokens ?? 0),
        cachedInputTokens: requestUsage?.usage.cachedInputTokens ?? 0,
      })
    : undefined;
  const authoritativeRequestCost = requestUsage?.estimatedCostDbu;
  const authoritativeRequestUsd = estimatedUsageUsd(requestUsage);
  const requestCostTarget = responding
    ? maxDefined(authoritativeRequestCost, requestCostEstimate)
    : authoritativeRequestCost;
  const requestUsdTarget = responding
    ? maxDefined(authoritativeRequestUsd, requestUsdEstimate)
    : authoritativeRequestUsd;
  const totalTokenTarget =
    usageValues.length > 0 || requestTokenTarget !== undefined
      ? authoritativeTotalTokens +
        (responding ? Math.max(0, (requestTokenTarget ?? 0) - authoritativeRequestTokens) : 0)
      : undefined;
  const totalCostTarget =
    hasAuthoritativeCost || requestCostTarget !== undefined
      ? authoritativeTotalCost +
        (responding ? Math.max(0, (requestCostTarget ?? 0) - (authoritativeRequestCost ?? 0)) : 0)
      : undefined;
  const authoritativeTotalUsd = usageValues.reduce(
    (sum, item) => sum + (estimatedUsageUsd(item) ?? 0),
    0,
  );
  const hasAuthoritativeUsd = usageValues.some((item) => estimatedUsageUsd(item) !== undefined);
  const totalUsdTarget =
    hasAuthoritativeUsd || requestUsdTarget !== undefined
      ? authoritativeTotalUsd +
        (responding
          ? Math.max(0, (requestUsdTarget ?? 0) - (authoritativeRequestUsd ?? 0))
          : 0)
      : undefined;
  const displayedRequestTokens = useAnimatedNumber(requestTokenTarget, responding, 1);
  const displayedTotalTokens = useAnimatedNumber(totalTokenTarget, responding, 1);
  const displayedRequestCost = useAnimatedNumber(requestCostTarget, responding, 0.0000001);
  const displayedTotalCost = useAnimatedNumber(totalCostTarget, responding, 0.0000001);
  const displayedRequestUsd = useAnimatedNumber(requestUsdTarget, responding, 0.0000001);
  const displayedTotalUsd = useAnimatedNumber(totalUsdTarget, responding, 0.0000001);
  const activeElapsed =
    startedAt.current === undefined ? 0 : Math.max(0, timerNow - startedAt.current);
  const requestTimeMs = startedAt.current === undefined ? latencyMs : activeElapsed;
  const displayedTotalTimeMs = totalTimeMs + activeElapsed;
  const currentMetrics: MetricValues = {
    tokens: formatTokens(displayedRequestTokens),
    time: requestTimeMs === undefined ? "—" : formatDuration(requestTimeMs),
    dbu: formatCost(displayedRequestCost),
    usd: formatUsd(displayedRequestUsd),
  };
  const totalMetrics: MetricValues = {
    tokens: formatTokens(displayedTotalTokens),
    time: displayedTotalTimeMs > 0 ? formatDuration(displayedTotalTimeMs) : "—",
    dbu: formatCost(displayedTotalCost),
    usd: formatUsd(displayedTotalUsd),
  };
  const mobileMetrics = metricScope === "current" ? currentMetrics : totalMetrics;
  return (
    <section className="flex min-h-0 w-[calc(100dvw-3rem)] min-w-[calc(100dvw-3rem)] shrink-0 snap-start snap-always flex-col overflow-hidden border border-border bg-background sm:w-full sm:min-w-[20rem] sm:flex-1 sm:basis-0 xl:min-w-[20rem]">
      <header className="shrink-0 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {pane.kind === "genie" ? (
              <SparklesIcon className="size-4 shrink-0 text-[#FF3621]" aria-hidden />
            ) : (
              <RouteIcon className="size-4 shrink-0 text-primary" aria-hidden />
            )}
            <h2 className="truncate text-sm font-semibold">{pane.title}</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-full"
            aria-label={`Close ${pane.title} chat`}
            title="Close chat"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="mt-1 flex justify-end sm:hidden">
          <div
            className="flex shrink-0 rounded-full bg-muted/60 p-0.5"
            role="group"
            aria-label="Metric scope"
          >
            <Button
              type="button"
              variant={metricScope === "current" ? "secondary" : "ghost"}
              size="sm"
              className="h-5 rounded-full px-2 text-[10px]"
              aria-pressed={metricScope === "current"}
              onClick={() => setMetricScope("current")}
            >
              Turn
            </Button>
            <Button
              type="button"
              variant={metricScope === "total" ? "secondary" : "ghost"}
              size="sm"
              className="h-5 rounded-full px-2 text-[10px]"
              aria-pressed={metricScope === "total"}
              onClick={() => setMetricScope("total")}
            >
              Total
            </Button>
          </div>
        </div>
        <div className="mt-1.5 grid grid-cols-4 divide-x divide-border/60 rounded-md bg-muted/35 py-1 text-xs sm:hidden">
          <Metric label="Tokens" value={mobileMetrics.tokens} />
          <Metric label="Time" value={mobileMetrics.time} />
          <Metric label="DBU" value={mobileMetrics.dbu} />
          <Metric label="USD" value={mobileMetrics.usd} />
        </div>
        <MetricTable current={currentMetrics} total={totalMetrics} />
      </header>
      <div className="flex min-h-0 flex-1">
        <ChatView
          {...chat}
          models={undefined}
          onModelChange={undefined}
          suggestions={[]}
          followUpSuggestions="none"
          showComposer={false}
          showThreadBarActions={false}
          className="min-h-0 flex-1"
        />
      </div>
    </section>
  );
};

type MetricValues = {
  tokens: string;
  time: string;
  dbu: string;
  usd: string;
};

const MetricTable = ({ current, total }: { current: MetricValues; total: MetricValues }) => (
  <table className="mt-1.5 hidden w-full table-fixed overflow-hidden rounded-md bg-muted/35 text-[10px] sm:table">
    <caption className="sr-only">Turn and total conversation metrics</caption>
    <colgroup>
      <col className="w-12" />
      <col />
      <col />
      <col />
      <col />
    </colgroup>
    <thead className="text-muted-foreground">
      <tr className="border-b border-border/60">
        <th scope="col" aria-label="Metric scope" />
        <MetricHeading>Tokens</MetricHeading>
        <MetricHeading>Time</MetricHeading>
        <MetricHeading>DBU</MetricHeading>
        <MetricHeading>USD</MetricHeading>
      </tr>
    </thead>
    <tbody>
      <MetricTableRow label="Turn" values={current} />
      <MetricTableRow label="Total" values={total} />
    </tbody>
  </table>
);

const MetricHeading = ({ children }: { children: React.ReactNode }) => (
  <th scope="col" className="truncate px-1 py-0.5 text-left font-normal leading-3">
    {children}
  </th>
);

const MetricTableRow = ({ label, values }: { label: string; values: MetricValues }) => (
  <tr className="border-b border-border/40 last:border-b-0">
    <th
      scope="row"
      className="truncate px-1.5 py-0.5 text-left font-medium leading-4 text-muted-foreground"
    >
      {label}
    </th>
    <MetricTableValue value={values.tokens} />
    <MetricTableValue value={values.time} />
    <MetricTableValue value={values.dbu} />
    <MetricTableValue value={values.usd} />
  </tr>
);

const MetricTableValue = ({ value }: { value: string }) => (
  <td className="px-1 py-0.5 leading-4 text-foreground tabular-nums" title={value}>
    <span className="block truncate">{value}</span>
  </td>
);

const Metric = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <div className="min-w-0 px-2 py-0.5 first:pl-1.5 last:pr-1.5">
    <div className="truncate text-[10px] leading-3 text-muted-foreground">{label}</div>
    <div
      className="truncate text-[11px] font-medium leading-4 text-foreground tabular-nums"
      title={title}
    >
      {value}
    </div>
  </div>
);

function recordUsage(
  setter: React.Dispatch<React.SetStateAction<UsageMap>>,
  usage: ModelUsagePartData,
): void {
  const key = usage.runId ?? `${usage.model}:${Date.now()}`;
  setter((current) => ({ ...current, [key]: usage }));
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? "—" : Math.round(value).toLocaleString();
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 0.001 ? value.toFixed(6) : value.toFixed(4);
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

type ChatMessageLike = {
  id: string;
  role: string;
  metadata?: unknown;
  parts: readonly { type: string; text?: string; data?: unknown }[];
};

type ConversationMetrics = {
  usage: UsageMap;
  requestUsage?: ModelUsagePartData;
  route?: ModelRoutePartData;
  latencyMs?: number;
  totalTimeMs: number;
};

function conversationMetrics(messages: readonly ChatMessageLike[]): ConversationMetrics {
  const usage: UsageMap = {};
  let requestUsage: ModelUsagePartData | undefined;
  let route: ModelRoutePartData | undefined;
  let latencyMs: number | undefined;
  let totalTimeMs = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === MODEL_ROUTE_PART_TYPE) {
        const parsed = ModelRoutePartDataSchema.safeParse(part.data);
        if (parsed.success) route = parsed.data;
      }
      if (part.type === MODEL_USAGE_PART_TYPE) {
        const parsed = ModelUsagePartDataSchema.safeParse(part.data);
        if (!parsed.success) continue;
        const item = parsed.data;
        usage[item.runId ?? message.id] = item;
        requestUsage = item;
        route = item;
      }
    }
    const timestamps = readBrowserMessageTimestamps({ metadata: message.metadata });
    if (!timestamps?.completedAt) continue;
    const createdAt = Date.parse(timestamps.createdAt);
    const completedAt = Date.parse(timestamps.completedAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(completedAt)) continue;
    const elapsed = Math.max(0, completedAt - createdAt);
    latencyMs = elapsed;
    totalTimeMs += elapsed;
  }
  return { usage, requestUsage, route, latencyMs, totalTimeMs };
}

function assistantTextLength(messages: readonly ChatMessageLike[]): number {
  return messages.reduce((total, message) => {
    if (message.role !== "assistant") return total;
    return (
      total +
      message.parts.reduce(
        (messageTotal, part) =>
          messageTotal +
          ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string"
            ? part.text.length
            : 0),
        0,
      )
    );
  }, 0);
}

function estimateRequestCost(
  pricing: NonNullable<ModelRoutePartData["pricing"]>,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | undefined {
  const billableInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const components = [
    [billableInputTokens, pricing.inputDbuPerMillionTokens],
    [usage.outputTokens, pricing.outputDbuPerMillionTokens],
    [usage.cachedInputTokens, pricing.cacheReadDbuPerMillionTokens],
  ] as const;
  let cost = 0;
  for (const [tokens, dbuPerMillionTokens] of components) {
    if (tokens === 0) continue;
    if (dbuPerMillionTokens === null) return undefined;
    cost += (tokens / 1_000_000) * dbuPerMillionTokens;
  }
  return cost;
}

function estimateRequestUsd(
  pricing: NonNullable<ModelRoutePartData["pricing"]>,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | undefined {
  const dbu = estimateRequestCost(pricing, usage);
  const usdPerDbu = averageUsdPerDbu(pricing);
  return dbu === undefined || usdPerDbu === undefined ? undefined : dbu * usdPerDbu;
}

function estimatedUsageUsd(usage: ModelUsagePartData | undefined): number | undefined {
  if (!usage?.pricing || usage.estimatedCostDbu === undefined) return undefined;
  const usdPerDbu = averageUsdPerDbu(usage.pricing);
  return usdPerDbu === undefined ? undefined : usage.estimatedCostDbu * usdPerDbu;
}

function averageUsdPerDbu(
  pricing: NonNullable<ModelRoutePartData["pricing"]>,
): number | undefined {
  const values = Object.values(pricing.usdPerDbu ?? {});
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function useAnimatedNumber(
  target: number | undefined,
  animate: boolean,
  minimumStep: number,
): number | undefined {
  const targetRef = useRef(target);
  const [displayed, setDisplayed] = useState(target);

  useEffect(() => {
    targetRef.current = target;
    setDisplayed((current) => {
      if (target === undefined || current === undefined || !animate || target < current)
        return target;
      return current;
    });
  }, [animate, target]);

  useEffect(() => {
    if (!animate) return;
    let frame = 0;
    const update = () => {
      setDisplayed((current) => {
        const next = targetRef.current;
        if (next === undefined || current === undefined || next <= current) return next;
        const remaining = next - current;
        return Math.min(next, current + Math.max(minimumStep, remaining * 0.18));
      });
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [animate, minimumStep]);

  return displayed;
}

export default SmartRouter;
