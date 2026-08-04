import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadSummary } from "../src/react/types.ts";
import { closeThreadTab, nextActiveThreadTab, syncThreadTabs } from "../src/support/thread-tabs.ts";

const thread = (id: string): ThreadSummary => ({ id, title: id });

describe("syncThreadTabs", () => {
  it("seeds from the newest conversations while the strip is empty", () => {
    const threads = [thread("a"), thread("b"), thread("c")];
    assert.deepEqual(syncThreadTabs([], threads, undefined, 2), ["a", "b"]);
  });

  it("keeps the active thread even when the server list has not caught up", () => {
    // A brand-new conversation is client-minted, so it only exists as the
    // selection until the first turn materializes it server-side.
    assert.deepEqual(syncThreadTabs([], [thread("a")], "new", 5), ["a", "new"]);
  });

  it("drops tabs whose conversation was deleted", () => {
    assert.deepEqual(syncThreadTabs(["a", "b", "c"], [thread("a"), thread("c")], "a"), ["a", "c"]);
  });

  it("returns the same array when nothing changed", () => {
    const open = ["a", "b"];
    const threads = [thread("a"), thread("b")];
    assert.equal(syncThreadTabs(open, threads, "b"), open);
  });

  it("reseeds after the last tab is closed", () => {
    // Closing every tab leaves an empty strip, which reseeds rather than
    // stranding the user with no way back into a conversation.
    assert.deepEqual(syncThreadTabs([], [thread("a"), thread("b")], undefined, 5), ["a", "b"]);
  });
});

describe("closeThreadTab", () => {
  it("removes one tab and leaves the rest in order", () => {
    assert.deepEqual(closeThreadTab(["a", "b", "c"], "b"), ["a", "c"]);
  });

  it("ignores an unknown id", () => {
    assert.deepEqual(closeThreadTab(["a"], "zzz"), ["a"]);
  });
});

describe("nextActiveThreadTab", () => {
  it("prefers the tab to the right", () => {
    assert.equal(nextActiveThreadTab(["a", "b", "c"], "b"), "c");
  });

  it("falls back to the tab on the left for the last tab", () => {
    assert.equal(nextActiveThreadTab(["a", "b"], "b"), "a");
  });

  it("has no successor for the only tab", () => {
    assert.equal(nextActiveThreadTab(["a"], "a"), undefined);
  });

  it("has no successor for an id that is not open", () => {
    assert.equal(nextActiveThreadTab(["a", "b"], "zzz"), undefined);
  });
});
