import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * The AppKit gate is the ONE part of bundle resolution that cannot live in the
 * polyglot fixtures: it keys off a Node-only optional peer Python has no analogue
 * for, and every shared fixture case sets `DBX_TOOLS_CONFIG_BUNDLE=true` to
 * bypass it on purpose. The app-shape rules the gate enforces are pinned here.
 *
 * Each case runs in a CHILD process, because a stub `databricks` CLI is only
 * reachable through the `env` handed to a spawn - mutating `process.env.PATH` in
 * this process would leave `bundleFile` running the real CLI.
 */
describe("bundleFile app gate", () => {
  it("reads the single app's config.env", () => {
    const result = probe(
      { resources: { apps: { demo: { config: { env: [{ name: "SAMPLE", value: "app" }] } } } } },
      ["SAMPLE"],
    );
    assert.deepEqual(result.values, ["app"]);
    assert.equal(result.file, true);
  });

  it("ignores root variables", () => {
    const result = probe(
      {
        resources: { apps: { demo: { config: { env: [{ name: "SAMPLE", value: "app" }] } } } },
        variables: { root_only: { value: "variable" } },
      },
      ["ROOT_ONLY", "SAMPLE"],
    );
    assert.deepEqual(result.values, [null, "app"]);
  });

  it("yields nothing when more than one app is defined", () => {
    const result = probe(
      {
        resources: {
          apps: {
            one: { config: { env: [{ name: "SAMPLE", value: "first" }] } },
            two: { config: { env: [{ name: "SAMPLE", value: "second" }] } },
          },
        },
      },
      ["SAMPLE"],
    );
    assert.deepEqual(result.values, [null]);
    assert.equal(result.file, false);
  });

  it("suppresses a bundle whose single app carries no config.env", () => {
    const result = probe({ resources: { apps: { demo: { source_code_path: "." } } } }, ["SAMPLE"]);
    assert.equal(result.file, false);
  });

  it("spawns validation once per context", () => {
    const result = probe(
      { resources: { apps: { demo: { config: { env: [{ name: "SAMPLE", value: "app" }] } } } } },
      ["SAMPLE", "SAMPLE"],
    );
    assert.deepEqual(result.values, ["app", "app"]);
    // One `bundleFile()` plus two `text()` lookups, all inside one context.
    assert.equal(result.calls, 1);
  });
});

interface ProbeResult {
  file: boolean;
  values: (string | null)[];
  calls: number;
}

/**
 * Resolve `keys` from a bundle whose `databricks bundle validate` prints
 * `payload`. `DBX_TOOLS_CONFIG_BUNDLE` is unset in the child so the real gate
 * runs; `@databricks/appkit` is a dev dependency here, so the resolve probe
 * passes and the app-shape rules are what is under test.
 */
function probe(payload: Record<string, unknown>, keys: string[]): ProbeResult {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-config-"));
  try {
    const bin = join(root, "bin");
    const counter = join(root, ".calls");
    const output = join(root, ".output");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, "databricks.yml"), "bundle: {}\n");
    writeFileSync(output, JSON.stringify(payload));
    const stub = join(bin, "databricks");
    writeFileSync(stub, `#!/bin/sh\necho call >> ${quote(counter)}\ncat ${quote(output)}\n`);
    chmodSync(stub, 0o755);
    const fixture = resolve(dirname(new URL(import.meta.url).pathname), "fixtures/bundle-probe.ts");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env.DBX_TOOLS_CONFIG_BUNDLE;
    delete env.NODE_ENV;
    env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    const result = spawnSync(process.execPath, [fixture, root, ...keys], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim()) as Omit<ProbeResult, "calls">;
    return { ...parsed, calls: lineCount(counter) };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function lineCount(path: string): number {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
