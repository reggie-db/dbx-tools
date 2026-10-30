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
      captured = body;
      const candidates = (body.state as { candidates: Array<{ id: string }> }).candidates;
      const selected = candidates.findIndex(({ id }) => id === "system.ai.thinking") + 1;
      return Promise.resolve({
        response: {
          answers: {
            model: {
              type: "choice",
              choice: `model_${selected}`,
              confidence: 0.82,
              probabilities: { model_1: 0.18, model_2: 0.82 },
            },
          },
        },
        metadata: { version: "1.0" },
      });
    });
    const endpoints: ServingEndpointSummary[] = [
      endpoint("system.ai.fast", ModelClass.ChatFast, 9, 9, 3),
      endpoint("system.ai.thinking", ModelClass.ChatThinking, 10, 4, 2),
      { ...endpoint("custom-private", ModelClass.ChatBalanced, 8, 8, 8), modelSource: "custom" },
    ];

    const result = await service.select(
      {
        messages: [
          { role: "system", content: "Answer accurately." },
          { role: "user", content: "Plan a migration with several constraints." },
        ],
        authorization: "do-not-send",
        tools: [{ function: { arguments: "do-not-send" } }],
      },
      endpoints,
      {} as WorkspaceClient,
      { strategy: "quality" },
    );

    assert.equal(result.endpoint.name, "system.ai.thinking");
    assert.equal(result.observation.confidence, 0.82);
    const state = captured?.state as {
      task: string;
      strategy: string;
      candidates: Array<Record<string, unknown>>;
    };
    assert.match(state.task, /Plan a migration/);
    assert.equal(state.task.includes("do-not-send"), false);
    assert.equal(state.strategy, "quality");
    assert.equal(state.candidates.length, 2);
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
          id: "system.ai.fast",
          rank: state.candidates.find(({ id }) => id === "system.ai.fast")?.rank,
          modelClass: ModelClass.ChatFast,
          profile: { quality: 9, speed: 9, cost: 3 },
        },
        {
          id: "system.ai.thinking",
          rank: state.candidates.find(({ id }) => id === "system.ai.thinking")?.rank,
          modelClass: ModelClass.ChatThinking,
          profile: { quality: 10, speed: 4, cost: 2 },
        },
      ],
    );
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
    const invoke = () => {
      calls += 1;
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
    assert.equal(calls, 1);
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
