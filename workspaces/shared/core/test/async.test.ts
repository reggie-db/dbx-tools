import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { async } from "../index";

describe("async.combineAbortSignals", () => {
  it("returns undefined when every source is absent", () => {
    assert.equal(async.combineAbortSignals(), undefined);
    assert.equal(async.combineAbortSignals(undefined, undefined), undefined);
  });

  it("passes a lone signal through without wrapping it", () => {
    const { signal } = new AbortController();
    assert.equal(async.combineAbortSignals(signal), signal);
    assert.equal(async.combineAbortSignals(undefined, signal, undefined), signal);
  });

  it("aborts when any source aborts, carrying that source's reason", () => {
    for (const index of [0, 1, 2]) {
      const controllers = [new AbortController(), new AbortController(), new AbortController()];
      const combined = async.combineAbortSignals(...controllers.map((c) => c.signal));
      assert.equal(combined?.aborted, false);
      controllers[index]!.abort(new Error(`source ${index}`));
      assert.equal(combined?.aborted, true);
      assert.equal((combined?.reason as Error).message, `source ${index}`);
    }
  });

  it("is already aborted when a source aborted before combining", () => {
    const early = new AbortController();
    early.abort(new Error("gone"));
    const combined = async.combineAbortSignals(early.signal, new AbortController().signal);
    assert.equal(combined?.aborted, true);
    assert.equal((combined?.reason as Error).message, "gone");
  });

  it("does not propagate back to the sources", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = async.combineAbortSignals(first.signal, second.signal);
    first.abort();
    assert.equal(combined?.aborted, true);
    assert.equal(second.signal.aborted, false);
  });
});
