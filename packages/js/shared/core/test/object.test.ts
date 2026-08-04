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

  it("rejects a duration when duration parsing is disabled", () => {
    assert.equal(object.toDate("-7d", { parseDuration: false }), undefined);
    assert.equal(object.toDate("2 weeks ago", { parseDuration: false }), undefined);
    // An absolute instant still parses with the fallback off.
    assert.equal(
      object.toDate("2026-08-02", { parseDuration: false })?.toISOString(),
      "2026-08-02T00:00:00.000Z",
    );
    assert.equal(object.toDate(1785697899, { parseDuration: false })?.getTime(), 1785697899000);
  });

  it("does not fuse a space- or comma-separated date into one epoch number", () => {
    // `toNumber` would read "2026 08 02" as 20260802 if separators were stripped,
    // landing in 1970 instead of 2026.
    assert.equal(object.toDate("2026 08 02")?.getFullYear(), 2026);
    assert.equal(object.toDate("August 2, 2026")?.getFullYear(), 2026);
  });
});

describe("object.toNumber", () => {
  it("accepts the spellings a hand-typed number arrives in", () => {
    assert.equal(object.toNumber(42), 42);
    assert.equal(object.toNumber(10n), 10);
    assert.equal(object.toNumber("1,000"), 1000);
    assert.equal(object.toNumber("1 000"), 1000);
    assert.equal(object.toNumber(" -2.5 "), -2.5);
    assert.equal(object.toNumber("- 2.5"), -2.5);
    assert.equal(object.toNumber(".5"), 0.5);
    assert.equal(object.toNumber("1."), 1);
    assert.equal(object.toNumber("1e3"), 1000);
    assert.equal(object.toNumber("1E-3"), 0.001);
  });

  it("divides a trailing percent by 100", () => {
    assert.equal(object.toNumber("25%"), 0.25);
    assert.equal(object.toNumber("12.5 %"), 0.125);
    assert.equal(object.toNumber("25%", { percent: false }), undefined);
  });

  it("keeps separators when they delimit fields rather than digit groups", () => {
    assert.equal(object.toNumber("1 000", { separators: false }), undefined);
    assert.equal(object.toNumber("1,000", { separators: false }), undefined);
    assert.equal(object.toNumber(" 1000 ", { separators: false }), 1000);
  });

  it("returns undefined where bare Number would invent a value", () => {
    // Every one of these is `0` or `NaN` through `Number`, so a caller using it
    // has to re-check the result on each call.
    assert.equal(object.toNumber(""), undefined);
    assert.equal(object.toNumber("   "), undefined);
    assert.equal(object.toNumber(null), undefined);
    assert.equal(object.toNumber(undefined), undefined);
    assert.equal(object.toNumber([]), undefined);
    assert.equal(object.toNumber(true), undefined);
    assert.equal(object.toNumber("12px"), undefined);
    assert.equal(object.toNumber("--1"), undefined);
    assert.equal(object.toNumber(Number.NaN), undefined);
    assert.equal(object.toNumber(Number.POSITIVE_INFINITY), undefined);
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
    assert.equal(object.toDuration("soon"), undefined);
    assert.equal(object.toDuration(""), undefined);
    assert.equal(object.toDuration(Number.NaN), undefined);
    assert.equal(object.toDuration(undefined), undefined);
  });

  it("reads a date as the signed offset from now", () => {
    const future = object.toDuration(new Date(Date.now() + 60_000))!;
    assert.ok(future > 55_000 && future <= 60_000, `${future}`);

    const past = object.toDuration("1 Jan 2020")!;
    assert.ok(past < 0, `${past}`);

    // The inverse of `toDate`, so a round trip lands back on the same instant.
    const iso = "2030-06-01T12:00:00.000Z";
    const roundTrip = object.toDate(object.toDuration(iso)! + Date.now())!;
    assert.ok(Math.abs(roundTrip.getTime() - Date.parse(iso)) < 5_000);
  });

  it("rejects a date when date parsing is disabled", () => {
    assert.equal(object.toDuration("1 Jan 2026", { parseDate: false }), undefined);
    assert.equal(object.toDuration(new Date(), { parseDate: false }), undefined);
    // A real duration still parses with the fallback off.
    assert.equal(object.toDuration("30s", { parseDate: false }), 30_000);
  });
});

describe("object.isSerializableValue", () => {
  it("accepts values a JSON round trip preserves", () => {
    assert.equal(object.isSerializableValue({ a: [1, "x", null, { b: true }] }), true);
    assert.equal(object.isSerializableValue([]), true);
    assert.equal(object.isSerializableValue(Object.create(null)), true);
  });

  it("rejects values JSON would silently coerce or drop", () => {
    // Each of these makes `JSON.stringify` succeed while CHANGING the value,
    // which is the failure this guard exists to catch.
    assert.equal(object.isSerializableValue(new Date()), false);
    assert.equal(object.isSerializableValue(Number.NaN), false);
    assert.equal(object.isSerializableValue(Number.POSITIVE_INFINITY), false);
    assert.equal(object.isSerializableValue(new Map()), false);
    assert.equal(object.isSerializableValue({ a: undefined }), false);
    assert.equal(object.isSerializableValue(10n), false);
    assert.equal(
      object.isSerializableValue(() => 1),
      false,
    );
    assert.equal(object.isSerializableValue(new (class Thing {})()), false);
  });

  it("rejects a cycle instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(object.isSerializableValue(cyclic), false);
  });

  it("does not treat a repeated sibling as a cycle", () => {
    const shared = { a: 1 };
    assert.equal(object.isSerializableValue([shared, shared]), true);
  });
});

describe("object.toStableKey", () => {
  it("ignores object key order but not array order", () => {
    assert.equal(object.toStableKey({ a: 1, b: 2 }), object.toStableKey({ b: 2, a: 1 }));
    assert.notEqual(object.toStableKey([1, 2]), object.toStableKey([2, 1]));
  });

  it("keeps values distinct that a looser canonicalizer would conflate", () => {
    assert.notEqual(object.toStableKey(1), object.toStableKey("1"));
    // Length-prefixing is what stops concatenated neighbours from re-splitting.
    assert.notEqual(object.toStableKey(["a", "bc"]), object.toStableKey(["ab", "c"]));
    // Unlike the hash module's canonicalizer, a Date is identified by instant.
    assert.notEqual(object.toStableKey(new Date(0)), object.toStableKey(new Date(1)));
    assert.notEqual(object.toStableKey(null), object.toStableKey(undefined));
    assert.notEqual(object.toStableKey(0), object.toStableKey(-0));
  });

  it("sorts set and map entries so insertion order does not leak", () => {
    assert.equal(object.toStableKey(new Set([1, 2])), object.toStableKey(new Set([2, 1])));
    assert.equal(
      object.toStableKey(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
      object.toStableKey(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    );
  });

  it("throws rather than inventing an identity it cannot guarantee", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => object.toStableKey(cyclic), TypeError);
    // NaN is not equal to itself, so it has no stable identity.
    assert.throws(() => object.toStableKey(Number.NaN), TypeError);
    assert.throws(() => object.toStableKey(() => 1), TypeError);
    assert.throws(() => object.toStableKey(Symbol("x")), TypeError);
  });
});
