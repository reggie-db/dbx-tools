import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RequestContext } from "@mastra/client-js";

import { snapshotRequestContext } from "../src/support/request-context.ts";

describe("Mastra request context snapshots", () => {
  it("captures plain typed application context without later mutation", () => {
    const context = { storeId: "store-1", page: "/stores/1" };
    const snapshot = snapshotRequestContext(context);
    context.storeId = "store-2";

    assert.deepEqual(snapshot, { storeId: "store-1", page: "/stores/1" });
  });

  it("accepts Mastra's native typed RequestContext", () => {
    const context = new RequestContext<{ storeId: string }>();
    context.set("storeId", "store-1");

    assert.deepEqual(snapshotRequestContext(context), { storeId: "store-1" });
  });

  it("rejects values that would not survive a JSON round trip unchanged", () => {
    assert.throws(
      () => snapshotRequestContext({ selectedAt: new Date() }),
      /JSON-serializable record/,
    );
  });
});
