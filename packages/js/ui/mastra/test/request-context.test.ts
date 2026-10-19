import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestContext } from "@mastra/client-js";

import { snapshotRequestContext } from "../src/support/request-context.ts";

describe("Mastra request context snapshots", () => {
  it("captures plain typed application context without later mutation", () => {
    const context = { storeId: "store-1", page: "/stores/1" };
    const snapshot = snapshotRequestContext(context);
    context.storeId = "store-2";

    assert.deepEqual(snapshot?.toJSON(), { storeId: "store-1", page: "/stores/1" });
  });

  it("accepts Mastra's native typed RequestContext", () => {
    const context = new RequestContext<{ storeId: string }>();
    context.set("storeId", "store-1");

    assert.deepEqual(snapshotRequestContext(context)?.toJSON(), { storeId: "store-1" });
  });

  it("uses Mastra's native serialization policy", () => {
    const selectedAt = new Date();
    const snapshot = snapshotRequestContext({ selectedAt });
    assert.equal(snapshot?.toJSON().selectedAt instanceof Date, true);
    assert.notEqual(snapshot?.toJSON().selectedAt, selectedAt);
  });
});
