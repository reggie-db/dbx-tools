import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";

import { resolveAgentRequestContext } from "../src/_agent-route-context.ts";

function routeContext(options: {
  agentId?: string;
  resourceId?: string;
  threadId?: string;
  knownAgent?: string;
}): ContextWithMastra {
  const agent = { id: options.knownAgent } as Agent;
  return {
    get(key: string) {
      if (key === "mastra") {
        return {
          getAgentById: (agentId: string) => (agentId === options.knownAgent ? agent : undefined),
        };
      }
      return {
        get: (requestKey: string) => {
          if (requestKey === MASTRA_RESOURCE_ID_KEY) return options.resourceId;
          if (requestKey === MASTRA_THREAD_ID_KEY) return options.threadId;
          return undefined;
        },
      };
    },
    req: {
      param: () => options.agentId,
    },
    json(body: unknown, status: number) {
      return Response.json(body, { status });
    },
  } as unknown as ContextWithMastra;
}

describe("agent route request context", () => {
  it("resolves dynamic agent, resource, and required thread ids", () => {
    const resolved = resolveAgentRequestContext(
      routeContext({
        agentId: "support",
        knownAgent: "support",
        resourceId: "user-1",
        threadId: "thread-1",
      }),
      { threadId: "required" },
    );

    assert.equal("error" in resolved, false);
    if ("error" in resolved) return;
    assert.equal(resolved.agentId, "support");
    assert.equal(resolved.resourceId, "user-1");
    assert.equal(resolved.threadId, "thread-1");
  });

  it("returns the shared missing-thread response when required", async () => {
    const resolved = resolveAgentRequestContext(
      routeContext({ agentId: "support", knownAgent: "support", resourceId: "user-1" }),
      { threadId: "required" },
    );

    assert.equal("error" in resolved, true);
    if (!("error" in resolved)) return;
    assert.equal(resolved.error.status, 400);
    assert.deepEqual(await resolved.error.json(), {
      error: "thread id missing from request context",
    });
  });
});
