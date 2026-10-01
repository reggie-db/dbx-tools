import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asyncUtils } from "../index.ts";

describe("asyncUtils.boundedRetryDelay", () => {
  it("caps an infinite retry sequence at the last configured delay", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 50].map((attempt) => asyncUtils.boundedRetryDelay(attempt)),
      [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000],
    );
  });
});

describe("asyncUtils.mapConcurrent", () => {
  it("bounds active callbacks and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await asyncUtils.mapConcurrent(
      [4, 3, 2, 1],
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(value);
        active -= 1;
        return value * 2;
      },
      { concurrency: 2 },
    );
    assert.deepEqual(results, [8, 6, 4, 2]);
    assert.equal(peak, 2);
  });

  it("settles every value and aggregates failures in input order", async () => {
    const attempted: number[] = [];
    await assert.rejects(
      asyncUtils.mapConcurrent(
        [0, 1, 2, 3],
        async (value) => {
          attempted.push(value);
          if (value === 1 || value === 3) throw new Error(`failure-${value}`);
        },
        { concurrency: 2, errorMode: "settle" },
      ),
      (err) => {
        assert.ok(err instanceof AggregateError);
        assert.deepEqual(err.errors.map(String), ["Error: failure-1", "Error: failure-3"]);
        return true;
      },
    );
    assert.deepEqual(attempted.sort(), [0, 1, 2, 3]);
  });

  it("rejects invalid concurrency", async () => {
    await assert.rejects(
      asyncUtils.mapConcurrent([1], async (value) => value, { concurrency: 0 }),
      /concurrency must be a positive integer/,
    );
  });
});

describe("poll", () => {
  it("waits between values skipped by the distinct filter", async () => {
    let attempts = 0;
    const values = asyncUtils.poll(
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

describe("asyncUtils.combineAbortSignals", () => {
  it("returns undefined when every source is absent", () => {
    assert.equal(asyncUtils.combineAbortSignals(), undefined);
    assert.equal(asyncUtils.combineAbortSignals(undefined, undefined), undefined);
  });

  it("passes a lone signal through without wrapping it", () => {
    const { signal } = new AbortController();
    assert.equal(asyncUtils.combineAbortSignals(signal), signal);
    assert.equal(asyncUtils.combineAbortSignals(undefined, signal, undefined), signal);
  });

  it("aborts when any source aborts, carrying that source's reason", () => {
    for (const index of [0, 1, 2]) {
      const controllers = [new AbortController(), new AbortController(), new AbortController()];
      const combined = asyncUtils.combineAbortSignals(...controllers.map((c) => c.signal));
      assert.equal(combined?.aborted, false);
      controllers[index]!.abort(new Error(`source ${index}`));
      assert.equal(combined?.aborted, true);
      assert.equal((combined?.reason as Error).message, `source ${index}`);
    }
  });

  it("is already aborted when a source aborted before combining", () => {
    const early = new AbortController();
    early.abort(new Error("gone"));
    const combined = asyncUtils.combineAbortSignals(early.signal, new AbortController().signal);
    assert.equal(combined?.aborted, true);
    assert.equal((combined?.reason as Error).message, "gone");
  });

  it("does not propagate back to the sources", () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = asyncUtils.combineAbortSignals(first.signal, second.signal);
    first.abort();
    assert.equal(combined?.aborted, true);
    assert.equal(second.signal.aborted, false);
  });
});
