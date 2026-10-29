import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelClass,
  type AutomaticRouteObservation,
  type ModelClass as ModelClassType,
} from "@dbx-tools/shared-model";
import type {
  ModelCapabilities,
  ModelTarget,
  RequestedFeatures,
} from "@dbx-tools/shared-model-gateway";

import {
  AutomaticModelRouter,
  automaticTurnKey,
  summarizeAutomaticRequest,
  type AutomaticRouteSelector,
  type AutomaticRouteStore,
} from "../src/automatic-routing.ts";

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
  selectorModel: "system.ai.openjev-qwen3.5-4b",
  selectorTokenBudget: 4_096,
  selectorTimeoutMs: 1_000,
  minimumConfidence: 0.5,
  preferCostEfficientModels: true,
  routeTtlSeconds: 600,
} as const;

describe("automatic model gateway routing", () => {
  it("pins one selected route across tool continuation requests", async () => {
    const selector = new FakeSelector();
    const store = new MemoryStore();
    const router = new AutomaticModelRouter(SETTINGS, selector, store);
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
    assert.equal(first.body.reasoning_effort, "high");
    assert.equal(second.target.id, "thinking");
    assert.equal(second.observation.source, "cache");
    assert.equal(selector.calls, 1);
    assert.equal(
      automaticTurnKey("openai-chat", initial),
      automaticTurnKey("openai-chat", continuation),
    );
  });

  it("does not reuse a route across separate top-level turns", async () => {
    const selector = new FakeSelector();
    const router = new AutomaticModelRouter(SETTINGS, selector, new MemoryStore());
    const input = {
      protocol: "openai-chat" as const,
      body: body([{ role: "user", content: "Refactor the authorization layer." }]),
      headers: new Headers(),
      features: FEATURES,
      targets: targets(),
      preferSystemModels: false,
      signal: new AbortController().signal,
    };

    await router.resolve(input);
    await router.resolve(input);

    assert.equal(selector.calls, 2);
  });

  it("summarizes prompt context without tool arguments", () => {
    const request = summarizeAutomaticRequest(
      "openai-responses",
      {
        model: "auto",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Investigate the failure" }] },
          { type: "function_call", name: "shell", arguments: "secret-command" },
          { type: "function_call_output", call_id: "1", output: "secret-output" },
        ],
        tools: [{ type: "function", name: "shell", parameters: { secret: true } }],
      },
      FEATURES,
      ["balanced", "thinking"],
      1_024,
    );

    assert.equal(request.currentRequest, "Investigate the failure");
    assert.deepEqual(request.toolNames, ["shell"]);
    assert.equal(JSON.stringify(request).includes("secret-command"), false);
    assert.equal(JSON.stringify(request).includes("secret-output"), false);
    assert.equal(request.continuation, true);
    assert.ok(request.selectorTokens <= 1_024);
  });

  it("uses the token budget instead of a six-message history limit", () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `short-${index}`,
    }));
    messages.push({ role: "user", content: "current request" });

    const request = summarizeAutomaticRequest(
      "openai-chat",
      { model: "auto", messages },
      { ...FEATURES, tools: false },
      ["fast", "balanced"],
      256,
    );

    assert.ok(request.recentContext.length > 6);
    assert.ok(request.selectorTokens > 0);
    assert.ok(request.selectorTokens <= 256);
  });

  it("treats tokenizer control literals as ordinary request text", () => {
    const request = summarizeAutomaticRequest(
      "openai-chat",
      {
        model: "auto",
        messages: [{ role: "user", content: "Explain <|endoftext|> literally" }],
      },
      { ...FEATURES, tools: false },
      ["fast", "balanced"],
      256,
    );

    assert.equal(request.currentRequest, "Explain <|endoftext|> literally");
    assert.ok(request.selectorTokens <= 256);
  });

  it("keeps models eligible when the existing gateway can translate the protocol", async () => {
    const translated = target("balanced", ModelClass.ChatBalanced, ["low", "medium"]);
    translated.capabilities = { ...translated.capabilities, anthropic: false };
    const router = new AutomaticModelRouter(SETTINGS, new FakeSelector(), new MemoryStore());

    const result = await router.resolve({
      protocol: "anthropic-messages",
      body: {
        model: "auto",
        messages: [{ role: "user", content: "Summarize this routine result." }],
      },
      headers: new Headers(),
      features: { ...FEATURES, tools: false },
      targets: [translated],
      preferSystemModels: false,
      signal: new AbortController().signal,
    });

    assert.equal(result.target.id, "balanced");
  });

  it("honors explicit Anthropic thinking effort without calling the selector", async () => {
    const selector = new FakeSelector();
    const router = new AutomaticModelRouter(SETTINGS, selector, new MemoryStore());
    const requestBody = {
      model: "auto",
      messages: [{ role: "user", content: "Analyze the incident." }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    };

    const result = await router.resolve({
      protocol: "anthropic-messages",
      body: requestBody,
      headers: new Headers(),
      features: { ...FEATURES, tools: false, reasoning: true },
      targets: targets(),
      preferSystemModels: false,
      signal: new AbortController().signal,
    });

    assert.equal(result.target.id, "thinking");
    assert.deepEqual(result.body, requestBody);
    assert.equal(selector.calls, 0);
  });
});

class FakeSelector implements AutomaticRouteSelector {
  calls = 0;

  select(): Promise<{
    tier: "thinking";
    reasoningEffort: "high";
    confidence: number;
    reasonCode: "large_refactor";
  }> {
    this.calls += 1;
    return Promise.resolve({
      tier: "thinking",
      reasoningEffort: "high",
      confidence: 0.9,
      reasonCode: "large_refactor",
    });
  }
}

class MemoryStore implements AutomaticRouteStore {
  private readonly values = new Map<string, AutomaticRouteObservation>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: AutomaticRouteObservation): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function body(messages: readonly Record<string, unknown>[]) {
  return {
    model: "auto",
    messages,
    tools: [{ type: "function", function: { name: "shell", parameters: {} } }],
  };
}

function targets(): ModelTarget[] {
  return [
    target("fast", ModelClass.ChatFast, ["minimal", "low"]),
    target("balanced", ModelClass.ChatBalanced, ["low", "medium"]),
    target("thinking", ModelClass.ChatThinking, ["high", "xhigh"]),
  ];
}

function target(
  id: string,
  modelClass: ModelClassType,
  reasoningEfforts: ModelTarget["reasoningEfforts"],
): ModelTarget {
  return {
    id,
    aliases: [id],
    displayName: id,
    endpoint: {
      name: id,
      task: "llm/v1/chat",
      class: modelClass,
      profile: {
        quality:
          modelClass === ModelClass.ChatThinking
            ? 3
            : modelClass === ModelClass.ChatBalanced
              ? 2
              : 1,
      },
      supportsTools: true,
      reasoningEfforts,
      status: { deprecated: false },
    },
    capabilities: CAPABILITIES,
    reasoningEfforts,
  };
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
