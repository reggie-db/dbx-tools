import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInterceptorContext, type LifecycleEvent } from "../src/interceptor.ts";

describe("lifecycle", () => {
  it("invokes handlers registered for the emitted event", async () => {
    const { context, emitLifecycle } = createInterceptorContext({});
    const seen: LifecycleEvent[] = [];
    context.onLifecycle("shutdown", () => void seen.push("shutdown"));
    context.onLifecycle("server:ready", () => void seen.push("server:ready"));

    await emitLifecycle("shutdown");

    assert.deepEqual(seen, ["shutdown"]); // only the matching handler ran
  });

  it("swallows a failing handler and still runs its siblings", async () => {
    const { context, emitLifecycle } = createInterceptorContext({});
    const ran: string[] = [];
    context.onLifecycle("shutdown", () => {
      throw new Error("boom");
    });
    context.onLifecycle("shutdown", () => void ran.push("second"));

    await assert.doesNotReject(emitLifecycle("shutdown"));
    assert.deepEqual(ran, ["second"]);
  });
});

describe("env", () => {
  it("exposes the resolved env passed in", () => {
    const { context } = createInterceptorContext({
      databricksHost: "https://example.databricks.com",
    });
    assert.equal(context.env.databricksHost, "https://example.databricks.com");
  });
});
