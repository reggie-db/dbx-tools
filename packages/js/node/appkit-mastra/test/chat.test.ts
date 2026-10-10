import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { log } from "@dbx-tools/shared-core";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";

import { buildAgents } from "../src/agents.ts";
import { agentAbortSignal, agentChatRoutes } from "../src/chat.ts";
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
      log: log.logger("test/chat"),
    });
    const attached = await buildAgents({
      config: {
        backgroundTurns: false,
        agents: { analyst: { instructions: "Answer directly." } },
      },
      context: undefined,
      log: log.logger("test/chat"),
    });
    const signal = new AbortController().signal;

    assert.equal(agentAbortSignal(durable.agents.analyst, signal), undefined);
    assert.equal(agentAbortSignal(attached.agents.analyst, signal), signal);
  });

  it("pins durable agent memory to the AppKit request context", async () => {
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, "thread-7");
    requestContext.set(MASTRA_RESOURCE_ID_KEY, "resource-7");
    const built = await buildAgents({
      config: { agents: { analyst: { instructions: "Answer directly." } } },
      context: undefined,
      memoryBuilder: { forAgent: () => ({}) } as unknown as MemoryBuilder,
      log: log.logger("test/chat"),
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
