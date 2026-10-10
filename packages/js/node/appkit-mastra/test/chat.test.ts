import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { log } from "@dbx-tools/shared-core";

import { buildAgents } from "../src/agents.ts";
import { agentAbortSignal, agentChatRoutes } from "../src/chat.ts";

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
});
