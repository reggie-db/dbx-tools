import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";

import { createMastraEvalDriver } from "../src/evaluation.ts";

function fixtureAgent(
  generate: (message: string, options: Record<string, unknown>) => unknown,
): Agent {
  return {
    id: "analyst",
    generate,
  } as unknown as Agent;
}

const contextFactory = async () => new RequestContext();

describe("Mastra AppKit EvalDriver", () => {
  it("maps native generate output and keeps two turns on one thread", async () => {
    const calls: Array<{ message: string; options: Record<string, unknown> }> = [];
    const agent = fixtureAgent(async (message, options) => {
      calls.push({ message, options });
      return {
        text: `reply:${message}`,
        toolCalls: [
          {
            payload: {
              toolName: "lookup",
              args: { id: message },
            },
          },
        ],
        error: undefined,
        suspendPayload: undefined,
        traceId: `trace:${message}`,
      };
    });
    const driver = createMastraEvalDriver(agent, {
      resourceId: "eval-resource",
      createRequestContext: contextFactory,
    });

    const first = await driver.send("one");
    const second = await driver.send("two");

    assert.deepEqual(first, {
      reply: "reply:one",
      toolCalls: ["lookup"],
      toolCallDetails: [{ name: "lookup", args: { id: "one" } }],
      succeeded: true,
      sessionId: first.sessionId,
      traceId: "trace:one",
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(
      calls.map(({ options }) => options.memory),
      [
        { thread: first.sessionId, resource: "eval-resource" },
        { thread: first.sessionId, resource: "eval-resource" },
      ],
    );
  });

  it("resets its thread and forwards timeout cancellation", async () => {
    const calls: Record<string, unknown>[] = [];
    const agent = fixtureAgent(async (_message, options) => {
      calls.push(options);
      return {
        text: "ok",
        toolCalls: [],
        error: undefined,
        suspendPayload: undefined,
        traceId: undefined,
      };
    });
    const driver = createMastraEvalDriver(agent, {
      createRequestContext: contextFactory,
    });
    const first = await driver.send("one");
    driver.reset?.();
    const controller = new AbortController();
    const second = await driver.send("two", { signal: controller.signal });

    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(calls[1]?.abortSignal, controller.signal);
  });

  it("reports generation failures and suspended runs as incomplete", async () => {
    const failing = createMastraEvalDriver(
      fixtureAgent(async () => {
        throw new Error("generation failed");
      }),
      { createRequestContext: contextFactory },
    );
    const suspended = createMastraEvalDriver(
      fixtureAgent(async () => ({
        text: "",
        toolCalls: [],
        error: undefined,
        suspendPayload: { toolCallId: "approval" },
        traceId: "trace-suspended",
      })),
      { createRequestContext: contextFactory },
    );

    const failure = await failing.send("fail");
    assert.deepEqual(failure, {
      reply: "generation failed",
      toolCalls: [],
      toolCallDetails: [],
      succeeded: false,
      sessionId: failure.sessionId,
    });
    assert.equal((await suspended.send("pause")).succeeded, false);
  });
});
