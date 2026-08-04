import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execution } from "../index.ts";

describe("execution.directExecutor", () => {
  it("returns successful values", async () => {
    const execute = execution.directExecutor<Record<string, never>>();
    assert.deepEqual(await execute(async () => "ok", {}), { ok: true, data: "ok" });
  });

  it("preserves numeric status codes from thrown errors", async () => {
    const execute = execution.directExecutor<Record<string, never>>();
    const cause = Object.assign(new Error("not found"), { statusCode: 404 });
    assert.deepEqual(await execute(async () => Promise.reject(cause), {}), {
      ok: false,
      status: 404,
      message: "not found",
    });
  });
});

describe("execution.run", () => {
  it("combines executor and caller cancellation signals", async () => {
    const executorController = new AbortController();
    const callerController = new AbortController();
    const execute: execution.Executor<Record<string, never>> = async (fn) => {
      const pending = fn(executorController.signal);
      callerController.abort(new Error("caller canceled"));
      return { ok: true, data: await pending };
    };

    const result = await execution.run({
      operation: "read",
      settings: {},
      execute,
      signal: callerController.signal,
      fn: (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(signal.reason), { once: true });
        }),
      canceled: () => new Error("canceled"),
      failed: () => new Error("failed"),
    });

    assert.equal((result as Error).message, "caller canceled");
  });

  it("uses the cancellation factory when the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      execution.run({
        operation: "read",
        settings: {},
        execute: async () => ({ ok: false, status: 500, message: "ignored" }),
        signal: controller.signal,
        fn: async () => undefined,
        canceled: () => new Error("canceled"),
        failed: () => new Error("failed"),
      }),
      /canceled/,
    );
  });

  it("passes sanitized failure details to the failure factory", async () => {
    await assert.rejects(
      execution.run({
        operation: "write",
        settings: {},
        execute: async () => ({ ok: false, status: 503, message: "unavailable" }),
        fn: async () => undefined,
        canceled: () => new Error("canceled"),
        failed: ({ operation, status, message }) => new Error(`${operation}:${status}:${message}`),
      }),
      /write:503:unavailable/,
    );
  });
});
