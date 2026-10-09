import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FilesCacheManager } from "../src/files-cache.ts";

const scope = {
  host: "https://workspace.example.com",
  workspaceId: "123",
};

describe("FilesCacheManager", () => {
  it("isolates values by user and invalidates active users across one workspace", async () => {
    const manager = new FilesCacheManager({ invalidationBatchMs: 60_000 });
    const first = await manager.forScope({ ...scope, userKey: "one" });
    const second = await manager.forScope({ ...scope, userKey: "two" });
    let firstLoads = 0;
    let secondLoads = 0;

    assert.equal(
      await first.read("same-key", () => {
        firstLoads += 1;
        return "first";
      }),
      "first",
    );
    assert.equal(
      await second.read("same-key", () => {
        secondLoads += 1;
        return "second";
      }),
      "second",
    );
    first.invalidate("same-key");
    await manager.flush();

    assert.equal(
      await first.read("same-key", () => {
        firstLoads += 1;
        return "first-new";
      }),
      "first-new",
    );
    assert.equal(
      await second.read("same-key", () => {
        secondLoads += 1;
        return "second-new";
      }),
      "second-new",
    );
    assert.deepEqual({ firstLoads, secondLoads }, { firstLoads: 2, secondLoads: 2 });
    await manager.close();
  });

  it("serves repeated reads from the process-local LRU", async () => {
    const manager = new FilesCacheManager();
    const cache = await manager.forScope({ ...scope, userKey: "one" });
    let loads = 0;

    await cache.read("key", () => {
      loads += 1;
      return "value";
    });
    await cache.read("key", () => {
      loads += 1;
      return "other";
    });
    await manager.flush();

    assert.equal(loads, 1);
    await manager.close();
  });

  it("retains filesystem sources by user and actual mounted paths", async () => {
    const manager = new FilesCacheManager();
    let loads = 0;
    const load = () => ({ instance: ++loads });
    const first = await manager.forFileSystem(
      { ...scope, userKey: "one" },
      { paths: ["/Workspace/.assistant", "/Workspace/Users/one"] },
      load,
    );
    const repeated = await manager.forFileSystem(
      { ...scope, userKey: "one" },
      { paths: ["/Workspace/.assistant/", "/Workspace/Users/one"] },
      load,
    );
    const otherPath = await manager.forFileSystem(
      { ...scope, userKey: "one" },
      { paths: ["/Workspace/.assistant"] },
      load,
    );
    const otherUser = await manager.forFileSystem(
      { ...scope, userKey: "two" },
      { paths: ["/Workspace/.assistant", "/Workspace/Users/one"] },
      load,
    );

    assert.equal(first, repeated);
    assert.notEqual(first, otherPath);
    assert.notEqual(first, otherUser);
    assert.equal(loads, 3);
    await manager.close();
  });
});
