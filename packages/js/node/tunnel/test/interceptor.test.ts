import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { InterceptorContext } from "@dbx-tools/appkit";
import { tunnelInterceptor } from "../src/interceptor.ts";

/** A recording {@link InterceptorContext} double - no real AppKit needed. */
function fakeContext(databricksHost?: string): InterceptorContext & {
  bound: unknown[];
  lifecycle: string[];
} {
  const bound: unknown[] = [];
  const lifecycle: string[] = [];
  return {
    bound,
    lifecycle,
    env: databricksHost ? { databricksHost } : {},
    onLifecycle: (event) => void lifecycle.push(event),
    onTeardown: () => {},
    broadcastSignal: () => {},
    bindProcess: (child) => void bound.push(child),
  };
}

const PORTR_ENV = ["PORTR_TOKEN", "PORTR_SERVER", "TUNNEL_PUBLIC_DOMAIN"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PORTR_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PORTR_ENV) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  delete process.env.DATABRICKS_HOST;
});

describe("tunnelInterceptor without portr configured", () => {
  it("is a no-op: binds no process when there is no PORTR_TOKEN / domain", () => {
    const ctx = fakeContext();
    tunnelInterceptor()(ctx);
    assert.equal(ctx.bound.length, 0);
    assert.equal(ctx.lifecycle.length, 0);
  });

  it("still applies the computed DATABRICKS_HOST from the context env", () => {
    delete process.env.DATABRICKS_HOST;
    const ctx = fakeContext("https://example.databricks.com");
    tunnelInterceptor()(ctx);
    assert.equal(process.env.DATABRICKS_HOST, "https://example.databricks.com");
  });

  it("does not override an explicit DATABRICKS_HOST already in the env", () => {
    process.env.DATABRICKS_HOST = "https://explicit.databricks.com";
    const ctx = fakeContext("https://computed.databricks.com");
    tunnelInterceptor()(ctx);
    assert.equal(process.env.DATABRICKS_HOST, "https://explicit.databricks.com");
  });
});
