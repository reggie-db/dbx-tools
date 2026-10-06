import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EnvCommandOptionsSchema, EnvExportFormatSchema } from "../src/env-export.ts";

describe("AppKit environment export options", () => {
  it("normalizes supported output aliases", () => {
    assert.equal(EnvExportFormatSchema.parse("bash"), "export");
    assert.equal(EnvExportFormatSchema.parse("cmd"), "windows");
    assert.equal(EnvExportFormatSchema.parse("json"), "json");
  });

  it("owns format and quiet defaults", () => {
    const options = EnvCommandOptionsSchema.parse({});
    assert.ok(options.format === "export" || options.format === "windows");
    assert.equal(options.quiet, false);
  });

  it("rejects unknown output formats", () => {
    assert.throws(() => EnvExportFormatSchema.parse("yaml"));
  });
});
