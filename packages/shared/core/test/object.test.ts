import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { object } from "../index.ts";

describe("object.toDate", () => {
  it("passes through a valid Date and rejects an invalid one", () => {
    const date = new Date("2026-08-02T12:00:00.000Z");
    assert.equal(object.toDate(date), date);
    assert.equal(object.toDate(new Date("nope")), undefined);
  });

  it("parses date and ISO timestamp strings", () => {
    assert.equal(object.toDate("2026-08-02")?.toISOString(), "2026-08-02T00:00:00.000Z");
    assert.equal(
      object.toDate("2026-08-02T12:00:00.000Z")?.toISOString(),
      "2026-08-02T12:00:00.000Z",
    );
    assert.equal(object.toDate("  2026-08-02  ")?.toISOString(), "2026-08-02T00:00:00.000Z");
  });

  it("reads a bare number as an epoch, inferring seconds vs milliseconds", () => {
    // Date.parse would read the seconds spelling as a YEAR, so both must agree.
    assert.equal(object.toDate(1785697899)?.getTime(), 1785697899000);
    assert.equal(object.toDate("1785697899")?.getTime(), 1785697899000);
    assert.equal(object.toDate(1785697899000)?.getTime(), 1785697899000);
    assert.equal(object.toDate("1785697899000")?.getTime(), 1785697899000);
  });

  it("handles fractional seconds and the epoch itself", () => {
    assert.equal(object.toDate(1.5)?.getTime(), 1500);
    assert.equal(object.toDate(0)?.getTime(), 0);
    assert.equal(object.toDate("0")?.getTime(), 0);
  });

  it("resolves a duration expression relative to now", () => {
    const before = Date.now();
    const week = object.toDate("-7d")!.getTime();
    const after = Date.now();
    assert.ok(week >= before - 604_800_000 && week <= after - 604_800_000);
    assert.ok(object.toDate("2 weeks ago")!.getTime() < Date.now());
    assert.ok(object.toDate("in 30 minutes")!.getTime() > Date.now());
  });

  it("accepts the `now` shorthand, so a cutoff can be set without a timestamp", () => {
    assert.ok(Math.abs(object.toDate("now")!.getTime() - Date.now()) < 5_000);
    assert.ok(Math.abs(object.toDate(" TODAY ")!.getTime() - Date.now()) < 5_000);
  });

  it("returns undefined for anything uninterpretable", () => {
    assert.equal(object.toDate(undefined), undefined);
    assert.equal(object.toDate(null), undefined);
    assert.equal(object.toDate(""), undefined);
    assert.equal(object.toDate("not-a-date"), undefined);
    assert.equal(object.toDate(Number.NaN), undefined);
    assert.equal(object.toDate(Number.POSITIVE_INFINITY), undefined);
    assert.equal(object.toDate({}), undefined);
  });
});

describe("object.toBoolean", () => {
  it("coerces the recognized truthy and falsy spellings", () => {
    for (const value of [true, "true", "T", " on ", "1", "yes", "y", 1]) {
      assert.equal(object.toBoolean(value), true, `expected ${String(value)} to be true`);
    }
    for (const value of [false, "false", "F", " off ", "0", "no", "n", 0]) {
      assert.equal(object.toBoolean(value), false, `expected ${String(value)} to be false`);
    }
  });

  it("returns undefined when the value carries no boolean meaning", () => {
    assert.equal(object.toBoolean("maybe"), undefined);
    assert.equal(object.toBoolean(2), undefined);
    assert.equal(object.toBoolean(undefined), undefined);
  });
});

describe("object.toDuration", () => {
  it("parses a single term across abbreviations, plurals, and casing", () => {
    for (const value of ["2ms", "2 ms", "2msec", "2 milliseconds", "2 Milliseconds", "2milli"]) {
      assert.equal(object.toDuration(value), 2, value);
    }
    for (const value of ["1h", "1 hr", "1 hour", "1 HOURS", "1     hours"]) {
      assert.equal(object.toDuration(value), 3_600_000, value);
    }
    assert.equal(object.toDuration("30s"), 30_000);
    assert.equal(object.toDuration("5 min"), 300_000);
    assert.equal(object.toDuration("2 days"), 172_800_000);
    assert.equal(object.toDuration("1 week"), 604_800_000);
    assert.equal(object.toDuration("1mo"), 2_592_000_000);
    assert.equal(object.toDuration("1y"), 31_536_000_000);
  });

  it("composes terms and ignores filler", () => {
    assert.equal(object.toDuration("1h30m"), 5_400_000);
    assert.equal(object.toDuration(" 1 hour and 30 minutes "), 5_400_000);
    assert.equal(object.toDuration("1,500 ms"), 1500);
    assert.equal(object.toDuration("1d 2h 3m 4s"), 93_784_000);
  });

  it("supports signs so a duration can express an offset", () => {
    assert.equal(object.toDuration("-30s"), -30_000);
    // An unsigned term inherits the previous sign, so this is -(1h + 30m).
    assert.equal(object.toDuration("-1h30m"), -5_400_000);
    assert.equal(object.toDuration("-1h +30m"), -1_800_000);
    assert.equal(object.toDuration("2 weeks ago"), -1_209_600_000);
    assert.equal(object.toDuration("in 45s"), 45_000);
  });

  it("treats a bare number as milliseconds", () => {
    assert.equal(object.toDuration(1500), 1500);
    assert.equal(object.toDuration("1500"), 1500);
    assert.equal(object.toDuration(-1500), -1500);
  });

  it("rejects an unknown unit rather than silently dropping it", () => {
    assert.equal(object.toDuration("1 fortnight"), undefined);
    assert.equal(object.toDuration("1h 2 fortnights"), undefined);
    assert.equal(object.toDuration("1 Jan 2026"), undefined);
    assert.equal(object.toDuration("soon"), undefined);
    assert.equal(object.toDuration(""), undefined);
    assert.equal(object.toDuration(Number.NaN), undefined);
    assert.equal(object.toDuration(undefined), undefined);
  });
});
