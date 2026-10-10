import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigurationError } from "@databricks/appkit";

import { MASTRA_CONFIG_SCHEMA } from "../src/config.ts";
import { normalizeGenieSpaces } from "../src/genie.ts";
import { invalidFields } from "../src/validation.ts";

describe("mastra config schema", () => {
  it("describes every published property", () => {
    const properties = Object.entries(MASTRA_CONFIG_SCHEMA.properties ?? {});
    assert.ok(properties.length > 0);
    for (const [name, schema] of properties) {
      assert.equal(typeof schema, "object", `${name} must be a schema object`);
      const description = (schema as { description?: unknown }).description;
      assert.equal(typeof description, "string", `${name} must carry a description`);
      assert.ok((description as string).length > 0, `${name} description must be non-empty`);
    }
  });
});

describe("genie space normalization", () => {
  it("wraps bare space ids and passes objects through", () => {
    assert.deepEqual(normalizeGenieSpaces({ default: "01ef", sales: { spaceId: "02ef" } }), {
      default: { spaceId: "01ef" },
      sales: { spaceId: "02ef" },
    });
  });

  it("treats no config as no spaces", () => {
    assert.deepEqual(normalizeGenieSpaces(undefined), {});
    assert.deepEqual(normalizeGenieSpaces({}), {});
  });

  it("fails loudly on an alias with no space id", () => {
    for (const spaces of [
      { default: undefined },
      { default: "" },
      { sales: { spaceId: "" } },
    ] as Parameters<typeof normalizeGenieSpaces>[0][]) {
      assert.throws(() => normalizeGenieSpaces(spaces), ConfigurationError);
    }
  });

  it("names the env var only for the default alias", () => {
    assert.throws(() => normalizeGenieSpaces({ default: undefined }), /DATABRICKS_GENIE_SPACE_ID/);
    assert.throws(() => normalizeGenieSpaces({ sales: undefined }), /genieSpaces\.sales/);
  });
});

describe("request body validation", () => {
  it("reports distinct dot-joined field paths", () => {
    assert.deepEqual(
      invalidFields({
        issues: [{ path: ["traceId"] }, { path: ["value", 0] }, { path: ["traceId"] }],
      }),
      ["traceId", "value.0"],
    );
  });

  it("drops the root path, which names no field", () => {
    assert.deepEqual(invalidFields({ issues: [{ path: [] }] }), []);
  });
});
