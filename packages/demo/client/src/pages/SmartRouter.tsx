import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@databricks/appkit-ui/react";
import { getAuthStatus } from "@dbx-tools/shared-auth";
import type { ModelRoutePartData, ModelUsagePartData } from "@dbx-tools/shared-mastra";
import {
  ChatView,
  isActiveChatStatus,
  isRespondingChatStatus,
  SuggestionPills,
  type ChatModelOption,
  type ChatStatus,
  useMastraChat,
} from "@dbx-tools/ui-mastra/react";
import { useMastraClient, useMastraModels } from "@dbx-tools/ui-mastra/support";
import {
  ArrowRightIcon,
  LoaderCircleIcon,
  PlusIcon,
  RouteIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

type PaneDescriptor = {
  id: string;
  kind: "mastra" | "genie";
  title: string;
  initialModel?: string;
};

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
    panes.push({
      id: crypto.randomUUID(),
      kind: "mastra",
      title: "Smart Router",
      initialModel: SMART_ROUTER_MODEL,
    });
  }
  if (models.some((model) => model.name === AI_DECIDE_MODEL)) {
    panes.push({
      id: crypto.randomUUID(),
      kind: "mastra",
      title: "AI Decide",
      initialModel: AI_DECIDE_MODEL,
    });
  }
  if (rankedModels.gpt) {
    panes.push({
      id: crypto.randomUUID(),
      kind: "mastra",
      title: "OpenAI",
      initialModel: rankedModels.gpt.name,
    });
  }
  if (rankedModels.claude) {
    panes.push({
      id: crypto.randomUUID(),
      kind: "mastra",
      title: "Anthropic",
      initialModel: rankedModels.claude.name,
    });
  }
  if (genieAvailable) {
    panes.push({ id: crypto.randomUUID(), kind: "genie", title: "Genie only" });
  }
  return panes;
}

const SmartRouter = () => {
  const [prompt, setPrompt] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(true);
  const [panes, setPanes] = useState<PaneDescriptor[]>([]);
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
    return () => suggestionController.current?.abort();
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
    setPanes(defaultPanes(models, genieAvailable, rankedModels));
  }, [genieAvailable, models, modelsLoading, rankedModels]);

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
  const submit = (suggestedPrompt?: string) => {
    const text = (suggestedPrompt ?? prompt).trim();
    if (!text || panes.length === 0) return;
    setPrompt("");
    setClearArmed(false);
    for (const pane of panes) controllers.current.get(pane.id)?.send(text);
    generateSuggestions(text);
  };
  const addPane = (value: string) => {
    if (value === GENIE_VALUE) {
      setPanes((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: "genie", title: "Genie only" },
      ]);
      return;
    }
    const initialModel = value;
    const model = models.find((candidate) => candidate.name === initialModel);
    setPanes((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: "mastra",
        title:
          initialModel === SMART_ROUTER_MODEL
            ? "Smart Router"
            : initialModel === AI_DECIDE_MODEL
              ? "AI Decide"
            : (model?.displayName ?? model?.name ?? "Mastra default"),
        initialModel,
      },
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
    setPrompt("");
    recentPrompts.current = [];
    generateSuggestions();
    void Promise.all([...controllers.current.values()].map((controller) => controller.clear()));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 md:p-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          One prompt, {panes.length} {panes.length === 1 ? "chat" : "chats"}
        </p>
        <Select value="" onValueChange={addPane}>
          <SelectTrigger className="h-9 w-44" aria-label="Add chat">
            <span className="flex items-center gap-2">
              <PlusIcon className="size-4" aria-hidden />
              <SelectValue placeholder="Add chat" />
            </span>
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
      </div>

      {panes.length > 0 ? (
        <div className="flex min-h-0 flex-1 snap-x snap-proximity scroll-px-3 gap-3 overflow-x-auto overscroll-x-contain pb-1 touch-pan-x [-webkit-overflow-scrolling:touch]">
          {panes.map((pane) => (
            <ModelChatPane
              key={pane.id}
              pane={pane}
              onClose={() => closePane(pane.id)}
              onRegister={registerPane}
              onStatusChange={reportStatus}
            />
          ))}
        </div>
      ) : defaultsInitialized.current ? (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
          Add a model or Genie chat to start comparing.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading available models...
        </div>
      )}

      <form
        className="shrink-0 rounded-xl border border-border bg-card p-3 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mb-2 min-h-8">
          {suggestionLoading ? (
            <div className="flex h-8 items-center gap-2 px-1 text-xs text-muted-foreground">
              <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
              <span>Generating suggestions...</span>
            </div>
          ) : (
            <SuggestionPills
              questions={suggestions}
              onSelect={submit}
              className="flex-nowrap overflow-x-auto md:flex-nowrap md:overflow-x-auto"
            />
          )}
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1">
            <Textarea
              value={prompt}
              rows={2}
              className="min-h-20 resize-none text-base"
              placeholder="Send a message…"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <div className="flex gap-2 lg:mb-0.5">
            <Button
              type="submit"
              className="flex-1 gap-2 lg:flex-none"
              disabled={!prompt.trim() || panes.length === 0}
            >
              Send to all
              <ArrowRightIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant={clearArmed ? "destructive" : "outline"}
              size="icon"
              aria-label={clearArmed ? "Confirm clear all chats" : "Clear all chats"}
              title={clearArmed ? "Click again to clear all chats" : "Clear all chats"}
              disabled={running || panes.length === 0}
              onClick={clearAll}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
};

const ModelChatPane = ({
  pane,
  onClose,
  onRegister,
  onStatusChange,
}: {
  pane: PaneDescriptor;
  onClose: () => void;
  onRegister: (id: string, controller?: PaneController) => void;
  onStatusChange: (id: string, status?: ChatStatus) => void;
}) => {
  const [threadId] = useState(() => crypto.randomUUID());
  const [usage, setUsage] = useState<UsageMap>({});
  const [requestUsage, setRequestUsage] = useState<ModelUsagePartData>();
  const [route, setRoute] = useState<ModelRoutePartData>();
  const [latencyMs, setLatencyMs] = useState<number>();
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
    enableClear: true,
    queueMessages: false,
    suggestions: [],
    threadId,
    threadPlacement: "disabled",
    requestContext: { route: "/smart-router", surface: pane.title },
  });
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;

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
  const knownInitialModel =
    pane.kind === "mastra" &&
    pane.initialModel !== SMART_ROUTER_MODEL &&
    pane.initialModel !== AI_DECIDE_MODEL &&
    pane.initialModel !== "gpt" &&
    pane.initialModel !== "claude"
      ? pane.initialModel
      : undefined;
  const model = route?.model ?? knownInitialModel;
  return (
    <section className="flex min-h-0 w-full min-w-full shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-background sm:min-w-[21rem] sm:flex-1 sm:basis-0 xl:min-w-[23rem]">
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {pane.kind === "genie" ? (
              <SparklesIcon className="size-4 shrink-0 text-[#FF3621]" aria-hidden />
            ) : (
              <RouteIcon className="size-4 shrink-0 text-primary" aria-hidden />
            )}
            <h2 className="truncate text-sm font-semibold">{pane.title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Close ${pane.title} chat`}
              title="Close chat"
              onClick={onClose}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        </div>
        <div className="mt-2 text-xs">
          <Metric label="Model" value={model ?? "—"} title={model} />
          <div className="mt-1.5 grid grid-cols-4 gap-1.5">
            <Metric label="Request tokens" value={formatTokens(displayedRequestTokens)} />
            <Metric
              label="Request time"
              value={requestTimeMs === undefined ? "—" : formatDuration(requestTimeMs)}
            />
            <Metric label="Request DBU" value={formatCost(displayedRequestCost)} />
            <Metric label="Request USD" value={formatUsd(displayedRequestUsd)} />
            <Metric label="Total tokens" value={formatTokens(displayedTotalTokens)} />
            <Metric
              label="Total time"
              value={displayedTotalTimeMs > 0 ? formatDuration(displayedTotalTimeMs) : "—"}
            />
            <Metric label="Total DBU" value={formatCost(displayedTotalCost)} />
            <Metric label="Total USD" value={formatUsd(displayedTotalUsd)} />
          </div>
        </div>
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

const Metric = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <div className="min-w-0 rounded-md bg-muted/50 px-2 py-1.5">
    <div className="text-[11px] text-muted-foreground">{label}</div>
    <div className="truncate font-medium text-foreground" title={title}>
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
  return `${value < 0.001 ? value.toFixed(6) : value.toFixed(4)} DBU`;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

type ChatMessageLike = {
  role: string;
  parts: readonly { type: string; text?: string }[];
};

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
