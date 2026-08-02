import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { env } from "../index.ts";

const KEYS = ["DBX_TOOLS_TEST_A", "DBX_TOOLS_TEST_B"] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("env.text", () => {
  it("returns the first non-empty variable in order", () => {
    process.env.DBX_TOOLS_TEST_A = "  ";
    process.env.DBX_TOOLS_TEST_B = " second ";
    assert.equal(env.text(KEYS), "second");
  });

  it("returns null when every candidate is absent or blank", () => {
    process.env.DBX_TOOLS_TEST_A = "";
    assert.equal(env.text(KEYS), null);
    assert.equal(env.text("DBX_TOOLS_TEST_A"), null);
  });
});

describe("env.string", () => {
  it("prefers the configured value over the environment", () => {
    process.env.DBX_TOOLS_TEST_A = "from-env";
    assert.equal(env.string("from-config", KEYS), "from-config");
  });

  it("treats a blank configured value as absent", () => {
    process.env.DBX_TOOLS_TEST_A = "from-env";
    assert.equal(env.string("   ", KEYS), "from-env");
  });
});

describe("env.boolean", () => {
  it("accepts the loose spellings an env var carries", () => {
    process.env.DBX_TOOLS_TEST_A = "on";
    assert.equal(env.boolean(undefined, KEYS), true);
    process.env.DBX_TOOLS_TEST_A = "0";
    assert.equal(env.boolean(undefined, KEYS), false);
  });

  it("returns undefined when neither source is interpretable, so ?? applies", () => {
    process.env.DBX_TOOLS_TEST_A = "maybe";
    assert.equal(env.boolean(undefined, KEYS), undefined);
    assert.equal(env.boolean(undefined, KEYS) ?? true, true);
  });

  it("honors a configured false over a truthy env var", () => {
    process.env.DBX_TOOLS_TEST_A = "true";
    assert.equal(env.boolean(false, KEYS), false);
  });
});

describe("env.positiveInt", () => {
  it("floors a configured value and ignores the environment", () => {
    process.env.DBX_TOOLS_TEST_A = "99";
    assert.equal(env.positiveInt(10.7, KEYS, 5), 10);
  });

  it("reads the first PRESENT variable, then the default", () => {
    process.env.DBX_TOOLS_TEST_B = "7";
    assert.equal(env.positiveInt(-1, KEYS, 5), 7);
    // An explicitly set alias wins even when it is unusable: falling through to
    // a later name would silently ignore what the deployment actually set.
    process.env.DBX_TOOLS_TEST_A = "0";
    assert.equal(env.positiveInt(undefined, KEYS, 5), 5);
  });
});

describe("env.list", () => {
  it("normalizes a comma/whitespace env string", () => {
    process.env.DBX_TOOLS_TEST_A = "a, b c";
    assert.deepEqual(env.list(undefined, KEYS), ["a", "b", "c"]);
  });

  it("prefers a configured array and applies the transform", () => {
    process.env.DBX_TOOLS_TEST_A = "z";
    assert.deepEqual(
      env.list(["A", "B"], KEYS, (entry) => entry.trim().toLowerCase()),
      ["a", "b"],
    );
  });

  it("returns an empty list when neither source has entries", () => {
    assert.deepEqual(env.list([], KEYS), []);
  });
});

describe("env.name", () => {
  it("returns the primary name from an alias list", () => {
    assert.equal(env.name(KEYS), KEYS[0]);
  });

  it("returns a bare string key as-is", () => {
    // The reason this helper exists: `"TUNNEL_AUTH_SESSION_EPOCH"[0]` is "T", so
    // indexing an EnvKey to name it in a log produces a nonexistent variable.
    assert.equal(env.name("TUNNEL_AUTH_SESSION_EPOCH"), "TUNNEL_AUTH_SESSION_EPOCH");
  });
});
