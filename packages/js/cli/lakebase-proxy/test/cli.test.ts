import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { json } from "@dbx-tools/shared-core";
import { buildProgram } from "../src/cli.ts";

const version = json.parseRecord(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
)?.version;

test("reports the package version", () => {
  expect(buildProgram().version()).toBe(version);
});

test("rejects ports outside the PostgreSQL TCP range", async () => {
  const program = buildProgram().exitOverride();
  expect(program.parseAsync(["node", "dbx-lakebase-proxy", "--port", "65536"])).rejects.toThrow(
    "port must not exceed 65535",
  );
});
