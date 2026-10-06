import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CliServiceDefinition, CliServiceLifecycle } from "@dbx-tools/cli-service";
import { json } from "@dbx-tools/shared-core";
import { buildProgram, lakebaseProxyServiceDefinition } from "../src/cli.ts";

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

test("persists Lakebase service listener and optional profile", async () => {
  let definition: CliServiceDefinition | undefined;
  const service: CliServiceLifecycle = {
    async install() {},
    async start() {},
    async stop() {},
    async restart() {},
    async uninstall() {},
    async status() {
      return { installed: false, running: false };
    },
  };
  await buildProgram("dbx lakebase-proxy", {
    service: {
      create(value) {
        definition = value;
        return service;
      },
      write() {},
    },
  }).parseAsync([
    "node",
    "dbx-lakebase-proxy",
    "service",
    "install",
    "--no-start",
    "--port",
    "5544",
    "--profile",
    "LAKEBASE-PROFILE",
  ]);

  expect(definition).toEqual(
    lakebaseProxyServiceDefinition({
      port: 5544,
      profile: "LAKEBASE-PROFILE",
    }),
  );
});
