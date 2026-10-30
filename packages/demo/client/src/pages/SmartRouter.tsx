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
import type { ModelUsagePartData } from "@dbx-tools/shared-mastra";
import {
  ChatView,
  isActiveChatStatus,
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
const GENIE_VALUE = "__genie__";
const EXAMPLES = [
  "Explain idempotency in API retries in two concise sentences.",
  "Design a zero-downtime plan to extract authentication from a TypeScript monolith, including rollout, rollback, observability, and data migration.",
] as const;

type PaneDescriptor = {
  id: string;
  kind: "mastra" | "genie";
  title: string;
  initialModel?: string;
};

type PaneController = {
  send: (text: string) => void;
  clear: () => Promise<void>;
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
  const [placeholderSuggestion, setPlaceholderSuggestion] = useState<string>();
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
  const defaultsInitialized = useRef(false);
  const mastraClient = useMastraClient();
  const { models, loading: modelsLoading } = useMastraModels();

  const cancelSuggestion = useCallback(() => {
    suggestionController.current?.abort();
    suggestionController.current = undefined;
    setPlaceholderSuggestion(undefined);
    setSuggestionLoading(false);
  }, []);
  const generateSuggestion = useCallback(
    (sentPrompt?: string) => {
      if (sentPrompt) {
        recentPrompts.current = [...recentPrompts.current, sentPrompt].slice(-8);
      }
      suggestionController.current?.abort();
      const controller = new AbortController();
      suggestionController.current = controller;
      setPlaceholderSuggestion(undefined);
      setSuggestionLoading(true);
      void mastraClient
        .generateSuggestions(
          {
            context: {
              purpose: "Compare how the available models answer the same prompt.",
              recentUserMessages: recentPrompts.current,
              exampleQueries: EXAMPLES,
            },
            maxSuggestions: 1,
            maxTokens: 96,
            existingSuggestions: recentPrompts.current,
          },
          controller.signal,
        )
        .then((questions) => {
          if (controller.signal.aborted) return;
          const recent = new Set(recentPrompts.current.map((value) => value.trim().toLowerCase()));
          const unique = [...new Set([...questions, ...EXAMPLES])].filter(
            (question) => !recent.has(question.trim().toLowerCase()),
          );
          const candidates = unique.length > 0 ? unique : [...new Set([...questions, ...EXAMPLES])];
          const suggestion = candidates[Math.floor(Math.random() * candidates.length)];
          setPlaceholderSuggestion(suggestion);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          const suggestion = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
          setPlaceholderSuggestion(suggestion);
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
    generateSuggestion();
    return () => suggestionController.current?.abort();
  }, [generateSuggestion]);

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
  const submit = () => {
    const text = prompt.trim() || placeholderSuggestion?.trim() || "";
    if (!text || panes.length === 0) return;
    setPrompt("");
    setPlaceholderSuggestion(undefined);
    setClearArmed(false);
    generateSuggestion(text);
    for (const pane of panes) controllers.current.get(pane.id)?.send(text);
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
    cancelSuggestion();
    recentPrompts.current = [];
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
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-1 touch-pan-x">
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
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1 space-y-1.5">
            <span className="text-sm font-medium">Shared input</span>
            <div className="relative">
              <Textarea
                value={prompt}
                rows={2}
                className="min-h-20 resize-none text-base"
                placeholder={
                  suggestionLoading
                    ? undefined
                    : (placeholderSuggestion ?? "Enter one prompt to send to every chat")
                }
                onFocus={cancelSuggestion}
                onChange={(event) => {
                  if (suggestionLoading || placeholderSuggestion) cancelSuggestion();
                  setPrompt(event.target.value);
                }}
              />
              {suggestionLoading && !prompt ? (
                <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 text-base text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
                  <span>Generating next question...</span>
                </div>
              ) : null}
            </div>
          </label>
          <div className="flex gap-2 lg:mb-0.5">
            <Button
              type="submit"
              className="flex-1 gap-2 lg:flex-none"
              disabled={
                (!prompt.trim() && !placeholderSuggestion?.trim()) || panes.length === 0
              }
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
        <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {EXAMPLES.map((example, index) => (
            <Button
              key={example}
              type="button"
              size="sm"
              variant="outline"
              className="h-auto shrink-0 rounded-full px-3 py-1.5 text-xs"
              onClick={() => {
                cancelSuggestion();
                setPrompt(example);
              }}
            >
              {index === 0 ? "Simple explanation" : "Complex migration"}
            </Button>
          ))}
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
  const [latencyMs, setLatencyMs] = useState<number>();
  const [totalTimeMs, setTotalTimeMs] = useState(0);
  const [timerNow, setTimerNow] = useState(() => performance.now());
  const startedAt = useRef<number | undefined>(undefined);
  const finishTiming = useCallback(() => {
    if (startedAt.current === undefined) return;
    const elapsed = performance.now() - startedAt.current;
    setLatencyMs(elapsed);
    setTotalTimeMs((total) => total + elapsed);
    startedAt.current = undefined;
  }, []);
  const recordModelUsage = useCallback((item: ModelUsagePartData) => {
    recordUsage(setUsage, item);
    finishTiming();
  }, [finishTiming]);
  const chat = useMastraChat({
    ...(pane.kind === "genie"
      ? { genieSpace: "default" }
      : {
          agentId: "models",
          model: pane.initialModel,
          onModelUsage: recordModelUsage,
        }),
    enableClear: true,
    queueMessages: false,
    suggestions: [],
    threadId,
    threadPlacement: "disabled",
    requestContext: { route: "/smart-router", surface: pane.title },
  });

  useEffect(() => {
    if (!isActiveChatStatus(chat.status)) return;
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
    if (!isActiveChatStatus(chat.status)) finishTiming();
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
        startedAt.current = now;
        chat.sendMessage({ text });
      },
      clear: async () => {
        startedAt.current = undefined;
        await chat.onClear?.();
        setUsage({});
        setLatencyMs(undefined);
        setTotalTimeMs(0);
        setTimerNow(performance.now());
      },
    });
    return () => {
      onRegister(pane.id, undefined);
      onStatusChange(pane.id, undefined);
    };
  }, [chat.onClear, chat.sendMessage, onRegister, onStatusChange, pane.id]);

  const usageValues = Object.values(usage);
  const latest = usageValues.at(-1);
  const totalTokens = usageValues.reduce((sum, item) => sum + item.usage.totalTokens, 0);
  const activeElapsed =
    startedAt.current === undefined ? 0 : Math.max(0, timerNow - startedAt.current);
  const requestTimeMs = startedAt.current === undefined ? latencyMs : activeElapsed;
  const displayedTotalTimeMs = totalTimeMs + activeElapsed;
  const knownInitialModel =
    pane.kind === "mastra" &&
    pane.initialModel !== SMART_ROUTER_MODEL &&
    pane.initialModel !== "gpt" &&
    pane.initialModel !== "claude"
      ? pane.initialModel
      : undefined;
  const model = latest?.model ?? knownInitialModel;
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
            <Metric
              label="Request tokens"
              value={latest ? latest.usage.totalTokens.toLocaleString() : "—"}
            />
            <Metric
              label="Request time"
              value={requestTimeMs === undefined ? "—" : formatDuration(requestTimeMs)}
            />
            <Metric
              label="Total tokens"
              value={usageValues.length > 0 ? totalTokens.toLocaleString() : "—"}
            />
            <Metric
              label="Total time"
              value={displayedTotalTimeMs > 0 ? formatDuration(displayedTotalTimeMs) : "—"}
            />
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

export default SmartRouter;
