import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { ModelClass } from "@dbx-tools/shared-model";
import type {
  ModelCapabilities,
  ModelTarget,
  RequestedFeatures,
  SmartRouterObservation,
  SmartRouterRequest,
} from "@dbx-tools/shared-model-gateway";

import {
  SmartModelRouter,
  SmartRouterContextBuilder,
  SmartRouterService,
  smartRouterCandidates,
  smartRouterTurnKey,
  type SmartRouterProbeRecord,
  type SmartRouterProbeStore,
  type SmartRouterStore,
} from "../src/smart-router.ts";

const FEATURES: RequestedFeatures = {
  background: false,
  customTools: false,
  parallelTools: false,
  previousResponse: false,
  reasoning: false,
  storage: false,
  structuredOutput: false,
  tools: true,
  unsupportedOpenResponsesTools: false,
  webSearch: false,
  imageInput: false,
  applyPatch: false,
};

const SETTINGS = {
  contextTokenBudget: 4_096,
  probeRefreshIntervalMs: 60_000,
  probeTtlMs: 60_000,
  routeTtlSeconds: 600,
  routerName: "task_v3",
  timeoutMs: 1_000,
} as const;

describe("Smart Router service", () => {
  it("merges partial settings with the shared defaults", async () => {
    let timeoutMs: number | undefined;
    const service = new SmartRouterService(
      { timeoutMs: 321 },
      (_client, request, _signal, timeout) => {
        timeoutMs = timeout;
        return Promise.resolve({
          route_selection: [{ route_option: request.route_options[0] }],
        });
      },
    );

    const result = await service.select(
      "Route this task",
      smartRouterCandidates(targets(), "codex"),
      {
        client: fakeClient(),
      },
    );

    assert.equal(timeoutMs, 321);
    assert.equal(result.routerName, "task_v3");
    service.dispose();
  });

  it("extracts task context from Responses, messages JSON, generic objects, and text", async () => {
    const builder = new SmartRouterContextBuilder(1_024);
    assert.match(
      await builder.build({
        input: [
          { role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] },
          { type: "function_call", name: "shell", arguments: "do-not-include" },
        ],
        tools: [{ name: "shell", api_key: "secret" }],
      }),
      /Refactor the parser/,
    );
    const messagesJson = JSON.stringify({
      messages: [{ role: "user", content: "Investigate the authorization failure" }],
    });
    assert.match(await builder.build(messagesJson), /authorization failure/);
    assert.equal(
      await builder.build({ request: { question: "Summarize the report" } }),
      "Summarize the report",
    );
    assert.equal(await builder.build("Plain text task"), "Plain text task");
    assert.equal(
      (await builder.build({ prompt: "safe", token: "secret" })).includes("secret"),
      false,
    );
  });

  it("calls task_v3 and maps the selected route back to its candidate", async () => {
    let captured: SmartRouterRequest | undefined;
    const service = new SmartRouterService(SETTINGS, (_client, request) => {
      captured = request;
      return Promise.resolve({
        route_selection: [
          {
            route_option: { model: "gpt-thinking", harness: "codex" },
            params: { task_tier: "High", profiler_status: "ok" },
          },
        ],
        rationale: "Cross-cutting implementation task.",
      });
    });
    const values = targets();
    const result = await service.select(
      { messages: [{ role: "user", content: "Refactor every package" }] },
      smartRouterCandidates(values, "codex"),
      { client: fakeClient() },
    );

    assert.equal(captured?.route_selector.router_name, "task_v3");
    assert.equal(captured?.route_options.length, 3);
    assert.equal(result.value.id, "thinking");
    assert.equal(result.params?.task_tier, "High");
  });

  it("memoizes one enablement probe per client and candidate menu", async () => {
    let calls = 0;
    const service = new SmartRouterService(SETTINGS, (_client, request) => {
      calls += 1;
      return Promise.resolve({
        route_selection: [{ route_option: request.route_options[0] }],
      });
    });
    const client = fakeClient();
    const candidates = smartRouterCandidates(targets(), "codex");

    assert.equal(await service.isEnabled(candidates, client), true);
    assert.equal(await service.isEnabled(candidates, client), true);
    assert.equal(calls, 1);
    service.dispose();
  });

  it("refreshes a cached positive probe after access and observes disablement", async () => {
    let calls = 0;
    const service = new SmartRouterService(
      { ...SETTINGS, probeRefreshIntervalMs: 10 },
      (_client, request) => {
        calls += 1;
        if (calls > 1) return Promise.reject(new Error("Smart Router disabled"));
        return Promise.resolve({
          route_selection: [{ route_option: request.route_options[0] }],
        });
      },
    );
    const client = fakeClient();
    const candidates = smartRouterCandidates(targets(), "codex");

    assert.equal(await service.isEnabled(candidates, client), true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, 1);
    assert.equal(await service.isEnabled(candidates, client), true);
    await waitFor(async () => (await service.isEnabled(candidates, client)) === false);
    assert.equal(calls, 2);
    service.dispose();
  });

  it("returns a stale memoized result while refreshing it in the background", async () => {
    let calls = 0;
    let finishRefresh: ((value: unknown) => void) | undefined;
    const service = new SmartRouterService({ ...SETTINGS, probeTtlMs: 1 }, (_client, request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          route_selection: [{ route_option: request.route_options[0] }],
        });
      }
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    });
    const client = fakeClient();
    const candidates = smartRouterCandidates(targets(), "codex");

    assert.equal(await service.isEnabled(candidates, client), true);
    await waitFor(async () => {
      assert.equal(await service.isEnabled(candidates, client), true);
      return calls === 2;
    });
    assert.equal(calls, 2);
    finishRefresh?.({ route_selection: [{ route_option: { model: "system.ai.gpt-fast" } }] });
    service.dispose();
  });

  it("reuses a fresh identity-scoped probe from the configured cache store", async () => {
    const store = new MemoryProbeStore();
    const candidates = smartRouterCandidates(targets(), "codex");
    const first = new SmartRouterService(
      SETTINGS,
      (_client, request) =>
        Promise.resolve({ route_selection: [{ route_option: request.route_options[0] }] }),
      store,
    );

    assert.equal(await first.isEnabled(candidates, fakeClient()), true);
    await waitFor(() => store.size > 0);
    assert.equal(store.ttlSeconds, 120);
    first.dispose();

    let calls = 0;
    const second = new SmartRouterService(
      SETTINGS,
      () => {
        calls += 1;
        return Promise.reject(new Error("should not probe"));
      },
      store,
    );
    assert.equal(await second.isEnabled(candidates, fakeClient()), true);
    assert.equal(calls, 0);
    second.dispose();
  });

  it("invalidates a positive probe when a real Smart Router request fails", async () => {
    let calls = 0;
    const service = new SmartRouterService(SETTINGS, (_client, request) => {
      calls += 1;
      if (calls > 1) return Promise.reject(new Error("Smart Router disabled"));
      return Promise.resolve({
        route_selection: [{ route_option: request.route_options[0] }],
      });
    });
    const client = fakeClient();
    const candidates = smartRouterCandidates(targets(), "codex");

    assert.equal(await service.isEnabled(candidates, client), true);
    await assert.rejects(service.select("task", candidates, { client }), /disabled/);
    assert.equal(await service.isEnabled(candidates, client), false);
    assert.equal(calls, 2);
    service.dispose();
  });

  it("rejects a route the caller did not offer", async () => {
    const service = new SmartRouterService(SETTINGS, () =>
      Promise.resolve({
        route_selection: [{ route_option: { model: "system.ai.unoffered", harness: "codex" } }],
      }),
    );
    await assert.rejects(
      service.select("task", smartRouterCandidates(targets(), "codex"), {
        client: fakeClient(),
      }),
      /unsupported model/,
    );
  });
});

describe("Smart Router gateway orchestration", () => {
  it("pins one selected model across tool continuations", async () => {
    let calls = 0;
    const service = new SmartRouterService(SETTINGS, () => {
      calls += 1;
      return Promise.resolve({
        route_selection: [{ route_option: { model: "system.ai.gpt-thinking", harness: "codex" } }],
      });
    });
    const router = new SmartModelRouter(SETTINGS, service, new MemoryStore(), fakeClient());
    const initial = body([
      { role: "user", content: "Refactor the authorization layer across every package." },
    ]);
    const continuation = body([
      { role: "user", content: "Refactor the authorization layer across every package." },
      { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
      { role: "tool", content: "completed" },
    ]);
    const common = {
      protocol: "openai-chat" as const,
      headers: new Headers(),
      features: FEATURES,
      targets: targets(),
      preferSystemModels: false,
      signal: new AbortController().signal,
    };

    const first = await router.resolve({ ...common, body: initial });
    const second = await router.resolve({ ...common, body: continuation });

    assert.equal(first.target.id, "thinking");
    assert.deepEqual(first.body, initial);
    assert.equal(second.target.id, "thinking");
    assert.equal(second.observation.source, "cache");
    assert.equal(calls, 1);

    const builder = new SmartRouterContextBuilder();
    assert.equal(
      smartRouterTurnKey(
        (await builder.analyze(initial)).logicalTurn,
        smartRouterCandidates(targets(), "codex"),
        { protocol: "openai-chat" },
      ),
      smartRouterTurnKey(
        (await builder.analyze(continuation)).logicalTurn,
        smartRouterCandidates(targets(), "codex"),
        { protocol: "openai-chat" },
      ),
    );
  });

  it("uses the Claude harness for Anthropic Messages", async () => {
    let captured: SmartRouterRequest | undefined;
    const service = new SmartRouterService(SETTINGS, (_client, request) => {
      captured = request;
      return Promise.resolve({
        route_selection: [
          { route_option: { model: "system.ai.claude-balanced", harness: "claude" } },
        ],
      });
    });
    const router = new SmartModelRouter(SETTINGS, service, new MemoryStore(), fakeClient());

    const result = await router.resolve({
      protocol: "anthropic-messages",
      body: {
        model: "smart-router",
        messages: [{ role: "user", content: "Analyze this incident" }],
      },
      headers: new Headers(),
      features: { ...FEATURES, tools: false },
      targets: targets(),
      preferSystemModels: false,
      signal: new AbortController().signal,
    });

    assert.equal(result.target.id, "balanced");
    assert.equal(
      captured?.route_options.every((option) => option.harness === "claude"),
      true,
    );
  });
});

class MemoryStore implements SmartRouterStore {
  private readonly values = new Map<string, SmartRouterObservation>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: SmartRouterObservation): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class MemoryProbeStore implements SmartRouterProbeStore {
  private readonly values = new Map<string, SmartRouterProbeRecord>();
  ttlSeconds?: number;

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: SmartRouterProbeRecord, ttlSeconds: number): Promise<void> {
    this.values.set(key, value);
    this.ttlSeconds = ttlSeconds;
    return Promise.resolve();
  }

  get size(): number {
    return this.values.size;
  }
}

function body(messages: readonly Record<string, unknown>[]) {
  return {
    model: "smart-router",
    messages,
    tools: [{ type: "function", function: { name: "shell", parameters: {} } }],
  };
}

function targets(): ModelTarget[] {
  return [
    target("fast", ModelClass.ChatFast, "system.ai.gpt-fast"),
    target("balanced", ModelClass.ChatBalanced, "system.ai.claude-balanced"),
    target("thinking", ModelClass.ChatThinking, "system.ai.gpt-thinking"),
  ];
}

function target(id: string, modelClass: ModelClass, modelServiceName: string): ModelTarget {
  return {
    id,
    aliases: [id],
    displayName: id,
    modelServiceName,
    endpoint: {
      name: id,
      task: "llm/v1/chat",
      class: modelClass,
      supportsTools: true,
      reasoningEfforts: ["low", "high"],
      modelServiceName,
      status: { deprecated: false },
    },
    capabilities: CAPABILITIES,
    reasoningEfforts: ["low", "high"],
  };
}

function fakeClient(): WorkspaceClient {
  return { config: {} } as unknown as WorkspaceClient;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Smart Router refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const CAPABILITIES: ModelCapabilities = {
  responses: true,
  openResponses: true,
  chat: true,
  anthropic: true,
  embeddings: false,
  aiGatewayCodex: true,
  tools: true,
  reasoning: true,
  streaming: true,
  parallelTools: true,
  customTools: true,
  structuredOutput: true,
  webSearch: true,
  imageInput: true,
  applyPatch: true,
};
