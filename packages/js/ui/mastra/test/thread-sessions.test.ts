import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueuedSteer } from "../src/react/types.ts";
import { enqueueSteer, removeSteer, reorderSteers } from "../src/support/thread-sessions.ts";

describe("steer queue", () => {
  const steer = (id: string, text: string): QueuedSteer => ({ id, text });

  it("enqueues oldest-first without mutating the input", () => {
    const q0: QueuedSteer[] = [];
    const q1 = enqueueSteer(q0, steer("a", "first"));
    const q2 = enqueueSteer(q1, steer("b", "second"));
    assert.deepEqual(
      q2.map((s) => s.id),
      ["a", "b"],
    );
    assert.equal(q0.length, 0);
    assert.equal(q1.length, 1);
  });

  it("removes by id and leaves the rest in order", () => {
    const q = [steer("a", "1"), steer("b", "2"), steer("c", "3")];
    assert.deepEqual(
      removeSteer(q, "b").map((s) => s.id),
      ["a", "c"],
    );
  });

  it("removing an unknown id is a no-op copy", () => {
    const q = [steer("a", "1")];
    assert.deepEqual(removeSteer(q, "zzz"), q);
  });

  it("reorders to match the given id order", () => {
    const q = [steer("a", "1"), steer("b", "2"), steer("c", "3")];
    assert.deepEqual(
      reorderSteers(q, ["c", "a", "b"]).map((s) => s.id),
      ["c", "a", "b"],
    );
  });

  it("appends any current steer missing from the order, and ignores unknown ids", () => {
    const q = [steer("a", "1"), steer("b", "2"), steer("c", "3")];
    // "b" omitted + a stale "zzz" present: zzz ignored, b appended after the rest.
    assert.deepEqual(
      reorderSteers(q, ["c", "zzz", "a"]).map((s) => s.id),
      ["c", "a", "b"],
    );
  });

  it("never duplicates when the order repeats an id", () => {
    const q = [steer("a", "1"), steer("b", "2")];
    assert.deepEqual(
      reorderSteers(q, ["a", "a", "b"]).map((s) => s.id),
      ["a", "b"],
    );
  });

  it("preserves each steer's captured request context through reordering", () => {
    const q = [
      { ...steer("a", "1"), requestContext: { storeId: "store-a" } },
      { ...steer("b", "2"), requestContext: { storeId: "store-b" } },
    ];

    assert.deepEqual(reorderSteers(q, ["b", "a"]), [q[1], q[0]]);
  });
});
