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
import { clearTrustedRequestContext } from "../src/server.ts";

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
