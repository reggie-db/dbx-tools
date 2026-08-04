import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "@databricks/appkit";
import { nextPollDelay, parsePort, parseSslMode, pollDelay } from "../src/lakebase-resolver.ts";

describe("PGPORT validation", () => {
  it("accepts a numeric string and a number", () => {
    assert.equal(parsePort("5433"), 5433);
    assert.equal(parsePort(5432), 5432);
  });

  it("treats absent and empty values as unset", () => {
    assert.equal(parsePort(undefined), undefined);
    assert.equal(parsePort(""), undefined);
  });

  it("rejects anything that is not a TCP port instead of yielding NaN", () => {
    for (const bad of ["abc", "0", "70000", "5432.5"]) {
      assert.throws(
        () => parsePort(bad),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /PGPORT/);
          return true;
        },
      );
    }
  });
});

describe("PGSSLMODE validation", () => {
  it("normalizes case and surrounding space", () => {
    assert.equal(parseSslMode(" Require "), "require");
    assert.equal(parseSslMode("disable"), "disable");
  });

  it("treats absent and empty values as unset", () => {
    assert.equal(parseSslMode(undefined), undefined);
    assert.equal(parseSslMode(""), undefined);
  });

  it("rejects a mode pg does not accept", () => {
    assert.throws(
      () => parseSslMode("verify-full"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /PGSSLMODE/);
        return true;
      },
    );
  });
});

describe("poll backoff", () => {
  it("grows with the attempt and stays inside the jitter band", () => {
    const base = 2_000;
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = nextPollDelay(attempt, base);
      assert.ok(delay >= 0);
      assert.ok(delay <= 15_000 * 1.2 + 1, `attempt ${attempt} produced ${delay}`);
    }
    const first = Array.from({ length: 20 }, () => nextPollDelay(0, base));
    const later = Array.from({ length: 20 }, () => nextPollDelay(4, base));
    assert.ok(Math.max(...first) < Math.min(...later));
  });

  it("caps the delay so a long wait keeps polling", () => {
    assert.ok(nextPollDelay(50, 2_000) <= 15_000 * 1.2 + 1);
  });

  it("rejects with the abort reason when cancelled mid-wait", async () => {
    const controller = new AbortController();
    const waiting = pollDelay(5, 10_000, controller.signal);
    const reason = new Error("boot cancelled");
    controller.abort(reason);
    await assert.rejects(waiting, reason);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    await assert.rejects(pollDelay(0, 10_000, AbortSignal.abort(new Error("gone"))), /gone/);
  });
});
