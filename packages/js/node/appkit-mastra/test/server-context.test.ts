import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";

import {
  MASTRA_REQUEST_ID_KEY,
  MASTRA_SCOPES_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
} from "../src/config.ts";
import { clearTrustedRequestContext, isMastraRequestAllowed } from "../src/server.ts";

describe("application request context boundary", () => {
  it("keeps application values and removes client-spoofable trusted fields", () => {
    const context = new RequestContext();
    context.setRaw("storeId", "store-1");
    context.setRaw(MASTRA_RESOURCE_ID_KEY, "attacker");
    context.setRaw(MASTRA_THREAD_ID_KEY, "attacker-thread");
    context.setRaw(MASTRA_USER_KEY, { id: "attacker" });
    context.setRaw(MASTRA_USER_EMAIL_KEY, "attacker@example.com");
    context.setRaw(MASTRA_REQUEST_ID_KEY, "attacker-request");
    context.setRaw(MASTRA_SCOPES_KEY, ["all-apis"]);

    clearTrustedRequestContext(context);

    assert.equal(context.getRaw("storeId"), "store-1");
    for (const key of [
      MASTRA_RESOURCE_ID_KEY,
      MASTRA_THREAD_ID_KEY,
      MASTRA_USER_KEY,
      MASTRA_USER_EMAIL_KEY,
      MASTRA_REQUEST_ID_KEY,
      MASTRA_SCOPES_KEY,
    ]) {
      assert.equal(context.hasRaw(key), false);
    }
  });
});

describe("scoped Mastra API gate", () => {
  const options = { access: "scoped", mcpEnabled: false } as const;

  it("allows resource-scoped native chat and memory operations", () => {
    for (const [method, path] of [
      ["POST", "/agents/support/stream"],
      ["POST", "/chat/support"],
      ["GET", "/agents/support/suspended-runs"],
      ["GET", "/memory/threads"],
      ["GET", "/memory/threads/thread-1/messages"],
      ["PATCH", "/memory/threads/thread-1"],
      ["DELETE", "/memory/threads/thread-1"],
      ["POST", "/memory/messages/delete"],
    ]) {
      assert.equal(isMastraRequestAllowed(method, path, options), true, `${method} ${path}`);
    }
  });

  it("keeps unrelated native administration routes closed", () => {
    for (const [method, path] of [
      ["POST", "/memory/threads"],
      ["POST", "/chat/support/tool-approval"],
      ["GET", "/memory/status"],
      ["DELETE", "/agents/support"],
    ]) {
      assert.equal(isMastraRequestAllowed(method, path, options), false, `${method} ${path}`);
    }
  });
});
