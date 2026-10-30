import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logger } from "@dbx-tools/shared-core";
import {
  MODEL_USAGE_PART_TYPE,
  RESPONSE_COMPLETE_PART_TYPE,
  THREAD_TITLE_PART_TYPE,
} from "@dbx-tools/shared-mastra";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import type { ChunkType } from "@mastra/core/stream";

import { buildAgents } from "../src/agents.ts";
import {
  agentAbortSignal,
  agentChatRoutes,
  buildModelUsageTransform,
  buildResponseCompleteTransform,
  buildThreadTitleTransform,
  CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS,
  startThreadTitle,
} from "../src/chat.ts";
import { withRequestMemoryScope, type MemoryBuilder } from "../src/memory.ts";
import { MASTRA_MODEL_ROUTE_KEY } from "../src/serving.ts";

async function transformResponseChunks(chunks: ChunkType[]): Promise<ChunkType[]> {
  const stream = new ReadableStream<ChunkType>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).pipeThrough(buildResponseCompleteTransform()());
  const transformed: ChunkType[] = [];
  for await (const chunk of stream) transformed.push(chunk);
  return transformed;
}

describe("background chat routes", () => {
  it("emits caller-facing model routing and cumulative usage", async () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_MODEL_ROUTE_KEY, {
      model: "databricks-gpt-test",
      selection: "smart-router",
      costPerMillionTokens: 2,
    });
    const finalStep = {
      type: "step-finish",
      runId: "run-1",
      from: "agent",
      payload: {
        totalUsage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
        stepResult: { reason: "stop" },
        output: { usage: {}, toolCalls: [] },
        metadata: {},
      },
    } as unknown as ChunkType;
    const stream = new ReadableStream<ChunkType>({
      start(controller) {
        controller.enqueue(finalStep);
        controller.close();
      },
    }).pipeThrough(buildModelUsageTransform(requestContext, "run-1")());
    const transformed: ChunkType[] = [];
    for await (const chunk of stream) transformed.push(chunk);

    assert.equal(transformed[1]?.type, MODEL_USAGE_PART_TYPE);
    assert.deepEqual(transformed[1], {
      type: MODEL_USAGE_PART_TYPE,
      data: {
        runId: "run-1",
        model: "databricks-gpt-test",
        selection: "smart-router",
        usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
        costPerMillionTokens: 2,
        estimatedCostUsd: 0.001,
      },
    });
  });

  it("marks only the final non-tool response step complete", async () => {
    const toolStep = {
      type: "step-finish",
      runId: "run-1",
      from: "agent",
      payload: {
        stepResult: { reason: "tool-calls" },
        output: {
          usage: {},
          toolCalls: [{ toolCallId: "tool-1", toolName: "lookup", input: {} }],
        },
        metadata: {},
      },
    } as unknown as ChunkType;
    const finalStep = {
      type: "step-finish",
      runId: "run-1",
      from: "agent",
      payload: {
        stepResult: { reason: "stop" },
        output: { usage: {}, toolCalls: [] },
        metadata: {},
      },
    } as unknown as ChunkType;

    const transformed = await transformResponseChunks([toolStep, finalStep]);

    assert.deepEqual(
      transformed.map((chunk) => chunk.type),
      ["step-finish", "step-finish", RESPONSE_COMPLETE_PART_TYPE],
    );
    assert.deepEqual(transformed[2], {
      type: RESPONSE_COMPLETE_PART_TYPE,
      data: null,
      transient: true,
    });
  });

  it("does not mark a continued text step complete", async () => {
    const continuedStep = {
      type: "step-finish",
      runId: "run-1",
      from: "agent",
      payload: {
        stepResult: { reason: "stop", isContinued: true },
        output: { usage: {}, toolCalls: [] },
        metadata: {},
      },
    } as unknown as ChunkType;

    const transformed = await transformResponseChunks([continuedStep]);

    assert.deepEqual(
      transformed.map((chunk) => chunk.type),
      ["step-finish"],
    );
  });

  it("holds terminal finish until the title future settles", async () => {
    let settleTitle!: () => void;
    const titleSettled = new Promise<string>((resolve) => {
      settleTitle = () => resolve("Synchronized Title");
    });
    const stream = new ReadableStream<ChunkType>({
      start(controller) {
        controller.enqueue({ type: "step-start" } as ChunkType);
        controller.enqueue({ type: "finish" } as ChunkType);
        controller.close();
      },
    }).pipeThrough(buildThreadTitleTransform(titleSettled)());
    const reader = stream.getReader();

    assert.equal((await reader.read()).value?.type, "step-start");
    const finish = reader.read();
    assert.equal(
      await Promise.race([finish.then(() => "finished"), Promise.resolve("waiting")]),
      "waiting",
    );

    settleTitle();
    assert.deepEqual(await finish, {
      done: false,
      value: {
        type: THREAD_TITLE_PART_TYPE,
        data: { title: "Synchronized Title" },
        transient: true,
      },
    });
    assert.equal((await reader.read()).value?.type, "finish");
  });

  it("generates and persists one title for an untitled thread", async () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-7");
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource-7");
    const created: unknown[] = [];
    let generated = 0;
    const memory = {
      getThreadById: async () => null,
      updateThread: async () => {
        throw new Error("unexpected update");
      },
      createThread: async (input: unknown) => {
        created.push(input);
        return input;
      },
    };
    const agent = {
      getMemory: async () => memory,
      generateTitleFromUserMessage: async (input: { message?: unknown; model?: unknown }) => {
        generated += 1;
        assert.equal(input.message, "Explain fast model routing");
        assert.equal(typeof input.model, "function");
        return "Fast Model Routing";
      },
    };

    const title = await startThreadTitle({
      agent: agent as never,
      config: {},
      requestContext,
      userText: "Explain fast model routing",
    });

    assert.equal(generated, 1);
    assert.equal(title, "Fast Model Routing");
    assert.deepEqual(created, [
      {
        threadId: "thread-7",
        resourceId: "resource-7",
        title: "Fast Model Routing",
      },
    ]);
  });

  it("does not regenerate or overwrite an existing thread title", async () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-7");
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource-7");
    let generated = 0;
    const agent = {
      getMemory: async () => ({
        getThreadById: async () => ({
          id: "thread-7",
          resourceId: "resource-7",
          title: "Existing title",
        }),
      }),
      generateTitleFromUserMessage: async () => {
        generated += 1;
        return "Replacement title";
      },
    };

    await startThreadTitle({
      agent: agent as never,
      config: {},
      requestContext,
      userText: "Another turn",
    });

    assert.equal(generated, 0);
  });

  it("registers chat, observe, and abort endpoints", () => {
    assert.deepEqual(
      agentChatRoutes().map((route) => [route.method, route.path]),
      [
        ["POST", "/chat/:agentId"],
        ["GET", "/chat/:agentId/runs/:runId"],
        ["POST", "/chat/:agentId/runs/:runId/abort"],
      ],
    );
  });

  it("detaches request cancellation only for evented agents", async () => {
    const durable = await buildAgents({
      config: { agents: { analyst: { instructions: "Answer directly." } } },
      context: undefined,
      log: logger("test/chat"),
    });
    const attached = await buildAgents({
      config: {
        backgroundTurns: false,
        agents: { analyst: { instructions: "Answer directly." } },
      },
      context: undefined,
      log: logger("test/chat"),
    });
    const signal = new AbortController().signal;

    assert.equal(agentAbortSignal(durable.agents.analyst, signal), undefined);
    assert.equal(agentAbortSignal(attached.agents.analyst, signal), signal);
  });

  it("bounds producerless run observation and preserves live runs", async () => {
    const built = await buildAgents({
      config: { agents: { analyst: { instructions: "Answer directly." } } },
      context: undefined,
      log: logger("test/chat"),
    });
    const agent = built.agents.analyst;
    let observeOptions: Parameters<typeof agent.observe>[1];
    agent.observe = (async (_runId, options) => {
      observeOptions = options;
      throw new Error("stop after options");
    }) as typeof agent.observe;
    agent.listActiveRuns = (async () => ({
      runs: [
        {
          runId: "run-7",
          status: "running",
          updatedAt: new Date(),
        },
      ],
      total: 1,
    })) as typeof agent.listActiveRuns;
    const route = agentChatRoutes().find(
      (candidate) => candidate.method === "GET" && candidate.path.includes("/runs/"),
    );
    assert.ok(route);

    const response = (await route.handler({
      get: (key: string) => (key === "mastra" ? { getAgentById: () => agent } : undefined),
      req: {
        param: (key: string) => (key === "agentId" ? "analyst" : "run-7"),
      },
    } as never)) as Response;
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const second = new TextDecoder().decode((await reader.read()).value);
    assert.match(`${first}${second}`, /data-stream-heartbeat/);

    assert.equal(observeOptions?.idleTimeoutMs, CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS);
    assert.equal(await observeOptions?.isAlive?.(), true);
    await reader.cancel();
  });

  it("rejects orphaned persisted runs even when their snapshot still says running", async () => {
    const built = await buildAgents({
      config: { agents: { analyst: { instructions: "Answer directly." } } },
      context: undefined,
      log: logger("test/chat"),
    });
    const agent = built.agents.analyst;
    agent.listActiveRuns = (async () => ({
      runs: [
        {
          runId: "run-orphaned",
          status: "running",
          updatedAt: new Date(0),
        },
      ],
      total: 1,
    })) as typeof agent.listActiveRuns;
    const route = agentChatRoutes().find(
      (candidate) => candidate.method === "GET" && candidate.path.includes("/runs/"),
    );
    assert.ok(route);

    const response = (await route.handler({
      get: (key: string) => (key === "mastra" ? { getAgentById: () => agent } : undefined),
      req: {
        param: (key: string) => (key === "agentId" ? "analyst" : "run-orphaned"),
      },
    } as never)) as Response;
    const body = await response.text();

    assert.match(body, /data-stream-heartbeat/);
    assert.match(body, /Run run-orphaned is no longer available/);
  });

  it("pins durable agent memory to the AppKit request context", async () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-7");
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource-7");
    const built = await buildAgents({
      config: { agents: { analyst: { instructions: "Answer directly." } } },
      context: undefined,
      memoryBuilder: { forAgent: () => ({}) } as unknown as MemoryBuilder,
      log: logger("test/chat"),
    });

    const options = await built.agents.analyst.getDefaultOptions({ requestContext });
    assert.equal(options.maxSteps, 25);
    assert.deepEqual(options.memory, { thread: "thread-7", resource: "resource-7" });
    assert.equal(typeof options.onFinish, "function");
  });

  it("overrides request-body memory ids with trusted AppKit routing", () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-7");
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource-7");

    assert.deepEqual(
      withRequestMemoryScope(
        { memory: { thread: "untrusted-thread", resource: "untrusted-resource" } },
        requestContext,
      ),
      { memory: { thread: "thread-7", resource: "resource-7" } },
    );
  });
});
