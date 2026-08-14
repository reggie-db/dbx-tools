import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { async } from "../index.ts";

describe("async.boundedRetryDelay", () => {
  it("caps an infinite retry sequence at the last configured delay", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 50].map((attempt) => async.boundedRetryDelay(attempt)),
      [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000],
    );
  });
});

describe("poll", () => {
  it("waits between values skipped by the distinct filter", async () => {
    let attempts = 0;
    const values = async.poll(
      () => {
        attempts += 1;
        return "same";
      },
      {
        intervalMs: 20,
        filter: "distinct",
        timeoutMs: 55,
      },
    );

    await assert.rejects(async () => {
      for await (const _value of values) {
        // The first value is yielded; later duplicates wait until timeout.
      }
    });
    assert.ok(attempts < 10, `expected a paced poll, got ${attempts} attempts`);
  });
});

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
