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
  ChatComposer,
  ChatView,
  isActiveChatStatus,
  selectedModelTurnMetrics,
  SuggestionPills,
  type ChatModelOption,
  type ChatStatus,
  useMastraChat,
} from "@dbx-tools/ui-mastra/react";
import { useMastraClient, useMastraModels } from "@dbx-tools/ui-mastra/support";
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
    window.localStorage.setItem(PANES_STORAGE_KEY, JSON.stringify({ version: 1, panes }));
  } catch {
    // Browser persistence is best-effort; the live comparison remains usable.
  }
}

type PaneController = {
  send: (text: string) => void;
  clear: () => Promise<void>;
  context: () => { title: string; messages: readonly ChatMessageLike[] };
};

function defaultPanes(
  models: readonly ChatModelOption[],
  genieAvailable: boolean,
  rankedModels: { gpt?: ChatModelOption; claude?: ChatModelOption },
): PaneDescriptor[] {
  const panes: PaneDescriptor[] = [];
  if (models.some((model) => model.name === SMART_ROUTER_MODEL)) {
    panes.push(
      createPane({
        kind: "mastra",
        title: "Smart Router",
        initialModel: SMART_ROUTER_MODEL,
      }),
    );
  }
  if (models.some((model) => model.name === AI_DECIDE_MODEL)) {
    panes.push(
      createPane({
        kind: "mastra",
        title: "AI Decide",
        initialModel: AI_DECIDE_MODEL,
      }),
    );
  }
  if (rankedModels.gpt) {
    panes.push(
      createPane({
        kind: "mastra",
        title: "OpenAI",
        initialModel: rankedModels.gpt.name,
      }),
    );
  }
  if (rankedModels.claude) {
    panes.push(
      createPane({
        kind: "mastra",
        title: "Anthropic",
        initialModel: rankedModels.claude.name,
      }),
    );
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
      setPanes((current) => [...current, createPane({ kind: "genie", title: "Genie only" })]);
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
  const chat = useMastraChat({
    ...(pane.kind === "genie"
      ? { genieSpace: "default" }
      : {
          agentId: "models",
          model: pane.initialModel,
          aiDecideStrategy: pane.initialModel === AI_DECIDE_MODEL ? "cost" : undefined,
          conversationHistory: "browser",
        }),
    showSelectedModel: true,
    metrics: ["time", "usd"],
    enableClear: true,
    enableRetry: false,
    enableFeedback: false,
    browserPersistence: true,
    queueMessages: false,
    suggestions: [],
    threadId: pane.threadId,
    threadPlacement: "disabled",
    requestContext: { route: "/smart-router", surface: pane.title },
  });
  const messagesRef = useRef(chat.messages);
  messagesRef.current = chat.messages;
  const totalMetrics = conversationTotalMetrics(chat.messages);
  const restoredContextReported = useRef(false);

  useEffect(() => {
    if (!chat.browserPersistenceHydrated) return;
    if (!restoredContextReported.current && chat.messages.length > 0) {
      restoredContextReported.current = true;
      onContextRestored();
    }
  }, [chat.browserPersistenceHydrated, chat.messages, onContextRestored]);

  useEffect(() => {
    onStatusChange(pane.id, chat.status);
  }, [chat.status, onStatusChange, pane.id]);
  useEffect(() => {
    onRegister(pane.id, {
      send: (text) => chat.sendMessage({ text }),
      clear: async () => {
        await chat.onClear?.();
      },
      context: () => ({ title: pane.title, messages: messagesRef.current }),
    });
    return () => {
      onRegister(pane.id, undefined);
      onStatusChange(pane.id, undefined);
    };
  }, [chat.onClear, chat.sendMessage, onRegister, onStatusChange, pane.id, pane.title]);

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
        <div
          className="mt-1.5 grid grid-cols-4 divide-x divide-border/60 rounded-md bg-muted/35 py-1 text-xs"
          aria-label="Conversation totals"
        >
          <Metric label="Tokens" value={formatTotalTokens(totalMetrics.tokens)} />
          <Metric label="Time" value={formatTotalDuration(totalMetrics.timeMs)} />
          <Metric label="DBU" value={formatTotalDbu(totalMetrics.dbu)} />
          <Metric label="USD" value={formatTotalUsd(totalMetrics.usd)} />
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

type ConversationTotalMetrics = {
  tokens?: number;
  timeMs?: number;
  dbu?: number;
  usd?: number;
};

function conversationTotalMetrics(messages: readonly ChatMessageLike[]): ConversationTotalMetrics {
  const totals = { tokens: 0, timeMs: 0, dbu: 0, usd: 0 };
  const available = { tokens: false, timeMs: false, dbu: false, usd: false };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const metrics = selectedModelTurnMetrics(message);
    if (!metrics) continue;
    for (const metric of ["tokens", "timeMs", "dbu", "usd"] as const) {
      const value = metrics[metric];
      if (value === undefined) continue;
      totals[metric] += value;
      available[metric] = true;
    }
  }
  return {
    ...(available.tokens ? { tokens: totals.tokens } : {}),
    ...(available.timeMs ? { timeMs: totals.timeMs } : {}),
    ...(available.dbu ? { dbu: totals.dbu } : {}),
    ...(available.usd ? { usd: totals.usd } : {}),
  };
}

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 px-1.5 py-0.5">
    <div className="truncate text-[10px] leading-3 text-muted-foreground">{label}</div>
    <div
      className="truncate text-[11px] font-medium leading-4 text-foreground tabular-nums"
      title={value}
    >
      {value}
    </div>
  </div>
);

function formatTotalTokens(value: number | undefined): string {
  return value === undefined ? "—" : Math.round(value).toLocaleString();
}

function formatTotalDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function formatTotalDbu(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 0.001 ? value.toFixed(6) : value.toFixed(4);
}

function formatTotalUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

type ChatMessageLike = {
  id: string;
  role: string;
  metadata?: unknown;
  parts: readonly { type: string; text?: string; data?: unknown }[];
};

export default SmartRouter;
