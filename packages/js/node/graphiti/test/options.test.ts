import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { options } from "@dbx-tools/shared-core";
import {
  GraphitiOptionsSchema,
  graphitiOptionsEnvironment,
  resolveGraphitiOptions,
} from "../src/options.ts";

describe("Graphiti runtime options", () => {
  it("composes Graphiti and subnamed FalkorDB defaults", () => {
    const resolved = resolveGraphitiOptions();

    assert.deepEqual(resolved.listen, {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 7272,
    });
    assert.deepEqual(resolved.falkorListen, {
      scheme: "tcp",
      host: "127.0.0.1",
      port: 6379,
    });
    assert.equal(resolved.falkorSnapshotSeconds, 300);
  });

  it("renders subnamed FalkorDB flags and owned environment names", () => {
    const values = {
      falkorDataDir: "/graphiti",
      falkorListen: "tcp://127.0.0.1:6380",
    };

    const flags = JSON.parse(
      options.serializeOpts(GraphitiOptionsSchema, values, "flag"),
    ) as Record<string, unknown>;
    assert.equal(flags["--falkor-data-dir"], "/graphiti");
    assert.equal(flags["--falkor-listen"], "tcp://127.0.0.1:6380");
    const environment = graphitiOptionsEnvironment(values);
    assert.equal(environment.FALKORDB_DATA_DIR, "/graphiti");
    assert.equal(environment.FALKORDB_LISTEN, "tcp://127.0.0.1:6380");
  });
});
