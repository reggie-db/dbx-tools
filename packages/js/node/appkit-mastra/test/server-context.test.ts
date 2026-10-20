import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import type express from "express";

import {
  MASTRA_REQUEST_ID_KEY,
  MASTRA_SCOPES_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
} from "../src/config.ts";
import {
  FOLLOW_UP_NATIVE_QUESTIONS_KEY,
  FOLLOW_UP_RUN_ID_KEY,
  FOLLOW_UP_USER_TEXT_KEY,
} from "../src/follow-up-suggestions.ts";
import { MASTRA_ORIGIN_KEY } from "../src/request-context.ts";
import {
  attachStaleResumeRecovery,
  clearTrustedRequestContext,
  isMastraRequestAllowed,
  requestOrigin,
} from "../src/server.ts";

describe("application request context boundary", () => {
  it("keeps application values and removes client-spoofable trusted fields", () => {
    const context = new RequestContext();
    context.setRaw("storeId", "store-1");
    context.setRaw(MASTRA_RESOURCE_ID_KEY, "attacker");
    context.setRaw(MASTRA_THREAD_ID_KEY, "attacker-thread");
    context.setRaw(MASTRA_USER_KEY, { id: "attacker" });
    context.setRaw(MASTRA_USER_EMAIL_KEY, "attacker@example.com");
    context.setRaw(MASTRA_REQUEST_ID_KEY, "attacker-request");
    context.setRaw(MASTRA_ORIGIN_KEY, "https://attacker.example");
    context.setRaw(MASTRA_SCOPES_KEY, ["all-apis"]);
    context.setRaw(FOLLOW_UP_USER_TEXT_KEY, "attacker question");
    context.setRaw(FOLLOW_UP_NATIVE_QUESTIONS_KEY, ["attacker suggestion"]);
    context.setRaw(FOLLOW_UP_RUN_ID_KEY, "attacker-run");

    clearTrustedRequestContext(context);

    assert.equal(context.getRaw("storeId"), "store-1");
    for (const key of [
      MASTRA_RESOURCE_ID_KEY,
      MASTRA_THREAD_ID_KEY,
      MASTRA_USER_KEY,
      MASTRA_USER_EMAIL_KEY,
      MASTRA_REQUEST_ID_KEY,
      MASTRA_ORIGIN_KEY,
      MASTRA_SCOPES_KEY,
      FOLLOW_UP_USER_TEXT_KEY,
      FOLLOW_UP_NATIVE_QUESTIONS_KEY,
      FOLLOW_UP_RUN_ID_KEY,
    ]) {
      assert.equal(context.hasRaw(key), false);
    }
  });

  it("resolves the deployed app origin without the Databricks shell host", () => {
    const headers = new Map([
      ["origin", "https://dbx-tools-demo-7474652124440999.aws.databricksapps.com"],
      ["host", "apps.databricks.com"],
    ]);
    assert.equal(
      requestOrigin({
        get: (name: string) => headers.get(name.toLowerCase()),
        protocol: "https",
      } as express.Request),
      "https://dbx-tools-demo-7474652124440999.aws.databricksapps.com",
    );
  });
});

describe("scoped Mastra API gate", () => {
  const options = { access: "scoped", mcpEnabled: false } as const;

  it("allows resource-scoped native chat and memory operations", () => {
    for (const [method, path] of [
      ["POST", "/agents/support/stream"],
      ["POST", "/chat/support"],
      ["GET", "/chat/support/runs/run-1"],
      ["POST", "/chat/support/runs/run-1/abort"],
      ["GET", "/agents/support/suspended-runs"],
      ["GET", "/memory/threads"],
      ["GET", "/memory/threads/thread-1/messages"],
      ["PATCH", "/memory/threads/thread-1"],
      ["DELETE", "/memory/threads/thread-1"],
      ["POST", "/memory/messages/delete"],
      ["POST", "/route/workflows/generatorDemoAssets/stream"],
    ]) {
      assert.equal(isMastraRequestAllowed(method, path, options), true, `${method} ${path}`);
    }
  });

  it("keeps unrelated native administration routes closed", () => {
    for (const [method, path] of [
      ["POST", "/memory/threads"],
      ["POST", "/chat/support/runs/run-1"],
      ["GET", "/chat/support/runs/run-1/abort"],
      ["POST", "/chat/support/tool-approval"],
      ["GET", "/memory/status"],
      ["DELETE", "/agents/support"],
    ]) {
      assert.equal(isMastraRequestAllowed(method, path, options), false, `${method} ${path}`);
    }
  });
});

describe("stale resume recovery", () => {
  it("finishes the chat stream instead of forwarding a settled workflow error", () => {
    const handlers: express.ErrorRequestHandler[] = [];
    attachStaleResumeRecovery({
      use: (handler: express.ErrorRequestHandler) => {
        handlers.push(handler);
      },
    } as express.Express);
    const chunks: string[] = [];
    const res = {
      headersSent: false,
      statusCode: 0,
      ended: false,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      write(chunk: string) {
        chunks.push(chunk);
      },
      end() {
        this.ended = true;
      },
    };
    let forwarded: unknown;
    handlers[0](
      new Error("This workflow run was not suspended"),
      { path: "/chat/support" } as express.Request,
      res as unknown as express.Response,
      (error?: unknown) => {
        forwarded = error;
      },
    );
    assert.equal(forwarded, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
    assert.equal(
      chunks.some((chunk) => chunk.includes("[DONE]")),
      true,
    );
  });
});
