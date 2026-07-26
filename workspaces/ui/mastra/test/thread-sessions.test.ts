import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { QueuedSteer, ToolEvent } from "../src/react/types";
import {
  enqueueSteer,
  removeSteer,
  reorderSteers,
  terminateRunningToolEvents,
} from "../src/support/thread-sessions";

const event = (id: string, status: ToolEvent["status"]): ToolEvent => ({
  id,
  toolName: "ask_genie",
  status,
});

describe("terminateRunningToolEvents", () => {
  it("settles running pills to done", () => {
    const next = terminateRunningToolEvents({
      msg1: [event("a", "running"), event("b", "done")],
      msg2: [event("c", "running")],
    });
    assert.deepEqual(
      next.msg1!.map((e) => e.status),
      ["done", "done"],
    );
    assert.deepEqual(
      next.msg2!.map((e) => e.status),
      ["done"],
    );
  });

  it("leaves already-terminal pills untouched and returns the same ref when nothing ran", () => {
    const input = {
      msg1: [event("a", "done"), event("b", "error")],
    };
    const next = terminateRunningToolEvents(input);
    // No running pills, so the map is returned unchanged (identity) to let
    // callers skip a needless state update.
    assert.equal(next, input);
  });

  it("handles an empty map", () => {
    const input = {};
    assert.equal(terminateRunningToolEvents(input), input);
  });
});

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
});
