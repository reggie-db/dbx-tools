import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { ModelClass, type ServingEndpointSummary } from "@dbx-tools/shared-model";

import { AiDecideRouterService } from "../src/ai-decide.ts";
import type { SmartRouterProbeRecord, SmartRouterProbeStore } from "../src/smart-router.ts";

describe("AiDecideRouterService", () => {
  it("sends normalized task context and ranked foundation-model metadata", async () => {
    let captured: Readonly<Record<string, unknown>> | undefined;
    const service = new AiDecideRouterService((_client, body) => {
      if ((body.questions as { task_complexity?: unknown }).task_complexity) {
        return Promise.resolve({
          response: {
            answers: { task_complexity: { type: "choice", choice: "simple" } },
          },
        });
      }
      captured = body;
      return Promise.resolve({
        response: {
          answers: {
            model: {
              type: "choice",
              choice: "model_1",
              confidence: 0.82,
              probabilities: { model_1: 1 },
            },
          },
        },
        metadata: { version: "1.0" },
      });
    });
    const endpoints: ServingEndpointSummary[] = [
      endpoint("databricks-gpt-5-4-mini", ModelClass.ChatFast, 9, 9, 3),
      endpoint("system.ai.thinking", ModelClass.ChatThinking, 10, 4, 2),
      { ...endpoint("custom-private", ModelClass.ChatBalanced, 8, 8, 8), modelSource: "custom" },
    ];

    const result = await service.select(
      {
        messages: [
          { role: "system", content: "Answer accurately." },
          { role: "user", content: "Explain idempotency in one short sentence." },
        ],
        authorization: "do-not-send",
        tools: [{ function: { arguments: "do-not-send" } }],
      },
      endpoints,
      {} as WorkspaceClient,
      { strategy: "quality" },
    );

    assert.equal(result.endpoint.name, "databricks-gpt-5-4-mini");
    assert.equal(result.observation.confidence, 0.82);
    const state = captured?.state as {
      task: string;
      current_request: string;
      conversation_turns: number;
      context_tokens: number;
      completion_requirement: string;
      strategy: string;
      candidates: Array<Record<string, unknown>>;
    };
    assert.match(state.task, /Explain idempotency/);
    assert.equal(state.current_request, "Explain idempotency in one short sentence.");
    assert.equal(state.conversation_turns, 1);
    assert.ok(state.context_tokens > 0);
    assert.match(state.completion_requirement, /Partial or truncated output is insufficient/);
    assert.equal(state.task.includes("do-not-send"), false);
    assert.equal(state.strategy, "quality");
    assert.equal(state.candidates.length, 1);
    const benchmarks = state.candidates.find(({ id }) => id === "databricks-gpt-5-4-mini")
      ?.benchmarks as Record<string, number | null>;
    assert.equal(benchmarks.quality_percentile, 60.75);
    assert.equal(benchmarks.normalized_response_time_ms, 3_840);
    assert.equal(benchmarks.time_to_first_token_ms, 446.472);
    assert.equal(benchmarks.output_tokens_per_second, 150.856);
    assert.equal(benchmarks.successful_run_count, 5);
    const instructions = (captured?.questions as { model: { instructions: string } }).model
      .instructions;
    assert.match(instructions, /Judge current_request/);
    assert.match(instructions, /dependencies, configuration, APIs, and multiple code artifacts/);
    assert.match(instructions, /Lower normalized_response_time_ms/);
    assert.equal((captured?.questions as { task_complexity?: unknown }).task_complexity, undefined);
    assert.deepEqual(
      state.candidates
        .map(({ id, rank, class: modelClass, profile }) => ({
          id,
          rank,
          modelClass,
          profile,
        }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      [
        {
          id: "databricks-gpt-5-4-mini",
          rank: state.candidates.find(({ id }) => id === "databricks-gpt-5-4-mini")?.rank,
          modelClass: ModelClass.ChatFast,
          profile: { quality: 9, speed: 9, cost: 3 },
        },
      ],
    );
  });

  it("uses the latest request as the primary task while retaining conversation context", async () => {
    let complexityBody: Readonly<Record<string, unknown>> | undefined;
    let modelBody: Readonly<Record<string, unknown>> | undefined;
    const service = new AiDecideRouterService((_client, body) => {
      if ((body.questions as { task_complexity?: unknown }).task_complexity) {
        complexityBody = body;
        return Promise.resolve({
          response: {
            answers: { task_complexity: { type: "choice", choice: "simple" } },
          },
        });
      }
      modelBody = body;
      return Promise.resolve({
        response: {
          answers: { model: { type: "choice", choice: "model_1" } },
        },
      });
    });

    await service.select(
      {
        messages: [
          {
            role: "user",
            content: "Design a zero-downtime authentication migration with rollback support.",
          },
          { role: "assistant", content: "Use dual writes, backfill, and staged cutover." },
          { role: "user", content: "Reply with exactly one word: hello" },
        ],
      },
      [
        endpoint("system.ai.luna", ModelClass.ChatFast, 35, 100, 0.1),
        endpoint("system.ai.terra", ModelClass.ChatBalanced, 45, 60, 1),
      ],
      {} as WorkspaceClient,
    );

    const complexityState = complexityBody?.state as {
      task: string;
      current_request: string;
      conversation_context?: string;
    };
    assert.equal(complexityState.task, "Reply with exactly one word: hello");
    assert.equal(complexityState.current_request, complexityState.task);
    assert.equal(complexityState.conversation_context, undefined);
    const state = modelBody?.state as {
      task: string;
      current_request: string;
      conversation_context: string;
      conversation_turns: number;
    };
    assert.equal(state.task, "Reply with exactly one word: hello");
    assert.equal(state.current_request, state.task);
    assert.match(state.conversation_context, /zero-downtime authentication migration/);
    assert.equal(state.conversation_turns, 2);
  });

  it("selects a simple task from fast candidates", async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    const service = new AiDecideRouterService((_client, body) => {
      calls.push(body);
      if (calls.length === 1) {
        return Promise.resolve({
          response: {
            answers: { task_complexity: { type: "choice", choice: "simple" } },
          },
        });
      }
      return Promise.resolve({
        response: {
          answers: { model: { type: "choice", choice: "model_1", confidence: 0.8 } },
        },
      });
    });

    const result = await service.select(
      "Reply with exactly one word: hello",
      [
        endpoint("system.ai.terra", ModelClass.ChatBalanced, 45, 60, 1),
        endpoint("system.ai.luna", ModelClass.ChatFast, 35, 100, 0.1),
        endpoint("system.ai.sol", ModelClass.ChatThinking, 55, 20, 2),
      ],
      {} as WorkspaceClient,
      { strategy: "balanced" },
    );

    assert.equal(result.endpoint.name, "system.ai.luna");
    assert.equal(calls.length, 2);
    const retryState = calls[1]?.state as {
      task_complexity: string;
      candidates: Array<{
        id: string;
        rank: number;
        class: string;
        profile: { quality: number; speed: number; cost: number };
        benchmarks: Record<string, number | null>;
        capabilities: { tools: boolean; structured_output: boolean };
      }>;
    };
    assert.equal(retryState.task_complexity, "simple");
    assert.deepEqual(
      retryState.candidates.map((candidate) => candidate.class),
      [ModelClass.ChatFast],
    );
    assert.equal(retryState.candidates[0]?.id, "system.ai.luna");
    assert.equal(retryState.candidates[0]?.rank, 1);
    assert.deepEqual(retryState.candidates[0]?.profile, { quality: 35, speed: 100, cost: 0.1 });
    assert.ok(retryState.candidates[0]?.benchmarks);
    assert.equal(retryState.candidates[0]?.capabilities.tools, true);
    assert.equal(retryState.candidates[0]?.capabilities.structured_output, true);
  });

  it("selects an advanced task from thinking candidates", async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    const service = new AiDecideRouterService((_client, body) => {
      calls.push(body);
      if (calls.length === 1) {
        return Promise.resolve({
          response: {
            answers: { task_complexity: { type: "choice", choice: "advanced" } },
          },
        });
      }
      return Promise.resolve({
        response: {
          answers: { model: { type: "choice", choice: "model_1", confidence: 0.8 } },
        },
      });
    });

    const result = await service.select(
      "Implement an endpoint with dependencies, configuration, and multiple code artifacts.",
      [
        endpoint("system.ai.terra", ModelClass.ChatBalanced, 45, 60, 1),
        endpoint("system.ai.sol", ModelClass.ChatThinking, 55, 20, 2),
      ],
      {} as WorkspaceClient,
      { strategy: "cost" },
    );

    assert.equal(result.endpoint.name, "system.ai.sol");
    assert.equal(calls.length, 2);
    const retryState = calls[1]?.state as {
      task_complexity: string;
      candidates: Array<{ class: string }>;
    };
    assert.equal(retryState.task_complexity, "advanced");
    assert.deepEqual(
      retryState.candidates.map((candidate) => candidate.class),
      [ModelClass.ChatThinking],
    );
    const retryInstructions = (calls[1]?.questions as { model: { instructions: string } }).model
      .instructions;
    assert.match(retryInstructions, /premier and newer unscored models eligible/);
    assert.match(retryInstructions, /prefer lower cost over lower latency/);
  });

  it("reuses an identity-scoped cached availability probe before exposing ai-decide", async () => {
    const values = new Map<string, SmartRouterProbeRecord>();
    const probeStore: SmartRouterProbeStore = {
      get: (key) => Promise.resolve(values.get(key)),
      set: (key, value) => {
        values.set(key, value);
        return Promise.resolve();
      },
    };
    let calls = 0;
    const invoke = (_client: WorkspaceClient, body: Readonly<Record<string, unknown>>) => {
      calls += 1;
      if ((body.questions as { task_complexity?: unknown }).task_complexity) {
        return Promise.resolve({
          response: {
            answers: { task_complexity: { type: "choice", choice: "simple" } },
          },
        });
      }
      return Promise.resolve({
        response: {
          answers: {
            model: { type: "choice", choice: "model_1", confidence: 0.9 },
          },
        },
      });
    };
    const endpoints = [
      endpoint("system.ai.fast", ModelClass.ChatFast, 9, 9, 3),
      endpoint("system.ai.thinking", ModelClass.ChatThinking, 10, 4, 2),
    ];
    const first = new AiDecideRouterService(invoke, probeStore);
    const second = new AiDecideRouterService(invoke, probeStore);

    assert.equal(await first.isEnabled(endpoints, { config: {} } as WorkspaceClient), true);
    assert.equal(await second.isEnabled(endpoints, { config: {} } as WorkspaceClient), true);
    assert.equal(calls, 2);
    first.dispose();
    second.dispose();
  });
});

function endpoint(
  name: string,
  modelClass: ModelClass,
  quality: number,
  speed: number,
  cost: number,
): ServingEndpointSummary {
  return {
    name,
    displayName: name,
    task: "llm/v1/chat",
    family: name.includes("thinking") ? "gpt" : "llama",
    class: modelClass,
    modelSource: "foundation",
    profile: { quality, speed, cost },
    supportsTools: true,
    supportsStructuredOutput: true,
    reasoningEfforts: modelClass === ModelClass.ChatThinking ? ["high"] : [],
  };
}
