import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ValidationError } from "@databricks/appkit";
import { resolveConfigValue, withCliSources, type ConfigSource } from "../src/bundle.ts";

const ENV_KEY = "DBX_TOOLS_APPKIT_TEST_VALUE";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("config precedence", () => {
  it("prefers explicit config over the environment", async () => {
    process.env[ENV_KEY] = "from-env";
    const value = await resolveConfigValue(ENV_KEY, {
      explicit: { [ENV_KEY]: "from-explicit" },
    });
    assert.equal(value, "from-explicit");
  });

  it("falls back to the environment when explicit config omits the key", async () => {
    process.env[ENV_KEY] = "from-env";
    const value = await resolveConfigValue(ENV_KEY, { explicit: { OTHER_KEY: "x" } });
    assert.equal(value, "from-env");
  });

  it("prepends explicit even when the caller passes its own source list", async () => {
    process.env[ENV_KEY] = "from-env";
    const value = await resolveConfigValue(ENV_KEY, {
      sources: ["env"],
      explicit: { [ENV_KEY]: "from-explicit" },
    });
    assert.equal(value, "from-explicit");
  });

  it("lets a cli flag win when cli sources are requested", async () => {
    process.env[ENV_KEY] = "from-env";
    const value = await resolveConfigValue(ENV_KEY, {
      sources: withCliSources(),
      cli: { [ENV_KEY]: "from-cli" },
      explicit: { [ENV_KEY]: "from-explicit" },
    });
    assert.equal(value, "from-cli");
  });

  it("orders cli sources ahead of explicit and the default sources", () => {
    assert.deepEqual(withCliSources(), ["cli", "explicit", "env", "bundle"]);
    assert.deepEqual(withCliSources(["explicit", "env"]), ["cli", "explicit", "env"]);
  });

  it("skips blank values instead of treating them as resolved", async () => {
    process.env[ENV_KEY] = "from-env";
    const value = await resolveConfigValue(ENV_KEY, { explicit: { [ENV_KEY]: "   " } });
    assert.equal(value, "from-env");
  });

  it("rejects an unknown source", async () => {
    await assert.rejects(
      () => resolveConfigValue(ENV_KEY, { sources: ["nope" as ConfigSource] }),
      ValidationError,
    );
  });
});
