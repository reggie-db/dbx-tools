import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logger } from "@dbx-tools/shared-core";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";

import { buildAgents } from "../src/agents.ts";
import {
  agentAbortSignal,
  agentChatRoutes,
  CHAT_RUN_OBSERVE_IDLE_TIMEOUT_MS,
} from "../src/chat.ts";
import { withRequestMemoryScope, type MemoryBuilder } from "../src/memory.ts";

describe("background chat routes", () => {
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

    assert.deepEqual(await built.agents.analyst.getDefaultOptions({ requestContext }), {
      maxSteps: 25,
      providerOptions: { openai: { store: false } },
      memory: { thread: "thread-7", resource: "resource-7" },
    });
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
