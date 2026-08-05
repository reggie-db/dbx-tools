import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import { bundle } from "../index.ts";

describe("appResources", () => {
  it("checks ancestors first and lazily streams every App resource", () => {
    const fixture = createFixture();
    try {
      const ancestor = writeBundle(fixture.root, {
        resources: {
          apps: {
            ancestor: { source_code_path: relative(fixture.root, fixture.appDirectory) },
          },
        },
      });
      const siblingDirectory = join(fixture.root, "bundles", "sibling");
      const siblingData = {
        resources: {
          apps: {
            ignored: { source_code_path: "another-app" },
            sibling: {
              source_code_path: relative(siblingDirectory, fixture.appDirectory),
              description: "Sibling bundle",
            },
          },
        },
      };
      const sibling = writeBundle(siblingDirectory, siblingData);
      writeBundle(join(fixture.root, ".git", "hidden"), {
        resources: {
          apps: {
            hidden: { source_code_path: fixture.appDirectory },
          },
        },
      });

      const first = readResources(fixture, 1);
      assert.deepEqual(
        first.map((result) => result.key),
        ["ancestor"],
      );
      assert.equal(readFileSync(fixture.callsPath, "utf8").trim(), fixture.root);

      const results = readResources(fixture);
      assert.deepEqual(
        results.map((result) => result.key),
        ["ancestor", "ignored", "sibling"],
      );
      assert.equal(results[0]?.bundlePath, ancestor);
      assert.equal(results[2]?.bundlePath, sibling);
      assert.deepEqual(results[2], {
        bundlePath: sibling,
        key: "sibling",
        sourceCodePath: fixture.appDirectory,
        data: siblingData,
        config: {
          source_code_path: relative(siblingDirectory, fixture.appDirectory),
          description: "Sibling bundle",
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("attaches validation failures and continues traversing", () => {
    const fixture = createFixture();
    try {
      const failed = writeBundle(
        join(fixture.root, "failed"),
        {
          resources: {
            apps: {
              partial: { description: "Partially resolved App" },
            },
          },
        },
        "invalid bundle",
      );
      const valid = writeBundle(join(fixture.root, "valid"), {
        resources: {
          apps: {
            valid: { source_code_path: fixture.appDirectory },
          },
        },
      });

      const results = readResources(fixture);
      const failure = results.find((result) => result.bundleFailure);
      const resource = results.find((result) => result.key === "valid");

      assert.equal(failure?.bundlePath, failed);
      assert.equal(failure?.key, "partial");
      assert.match(failure?.bundleFailure ?? "", /invalid bundle/);
      assert.equal(resource?.bundlePath, valid);
      assert.equal(resource?.bundleFailure, undefined);
    } finally {
      fixture.cleanup();
    }
  });

  it("omits failed bundles that produce no App resources", () => {
    const fixture = createFixture();
    try {
      writeBundle(join(fixture.root, "failed"), {}, "invalid bundle");

      const results = readResources(fixture);

      assert.deepEqual(results, []);
    } finally {
      fixture.cleanup();
    }
  });

  it("throws for malformed successful validation output when consumed", () => {
    const fixture = createFixture();
    try {
      writeBundle(join(fixture.root, "malformed"), "not JSON");

      const result = runProbe(fixture);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid bundle JSON/);
    } finally {
      fixture.cleanup();
    }
  });

  it("yields nothing for unusable boundaries and working directories", async () => {
    const fixture = createFixture();
    const boundary = join(fixture.root, "bundles");
    mkdirSync(boundary);
    try {
      assert.deepEqual(
        await Array.fromAsync(bundle.appResources(boundary, fixture.appDirectory)),
        [],
      );
      assert.deepEqual(
        await Array.fromAsync(bundle.appResources(join(fixture.root, "missing"))),
        [],
      );
      assert.deepEqual(
        await Array.fromAsync(bundle.appResources(fixture.root, join(fixture.root, "missing"))),
        [],
      );
    } finally {
      fixture.cleanup();
    }
  });
});

type Fixture = {
  root: string;
  appDirectory: string;
  binDirectory: string;
  callsPath: string;
  cleanup: () => void;
};

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dbx-tools-bundle-")));
  const appDirectory = join(root, "apps", "demo");
  const binDirectory = join(root, "bin");
  const callsPath = join(root, ".bundle-calls");
  mkdirSync(appDirectory, { recursive: true });
  mkdirSync(binDirectory);

  const executable = join(binDirectory, "databricks");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ -n "$BUNDLE_CALLS" ]; then echo "$PWD" >> "$BUNDLE_CALLS"; fi',
      'cat "$PWD/.validation-output"',
      'if [ -f "$PWD/.validation-error" ]; then',
      '  cat "$PWD/.validation-error" >&2',
      "  exit 42",
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);

  return {
    root,
    appDirectory,
    binDirectory,
    callsPath,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type ProbeResource = {
  bundlePath: string;
  key: string;
  sourceCodePath?: string;
  config: Record<string, unknown>;
  data: Record<string, unknown>;
  bundleFailure?: string;
};

function runProbe(fixture: Fixture, limit?: number) {
  const probe = join(import.meta.dir, "fixtures", "app-resources-probe.ts");
  const args = [probe, fixture.root, fixture.appDirectory];
  if (limit !== undefined) args.push(String(limit));
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      BUNDLE_CALLS: fixture.callsPath,
      PATH: `${fixture.binDirectory}:${process.env.PATH ?? ""}`,
    },
  });
}

function readResources(fixture: Fixture, limit?: number): ProbeResource[] {
  const result = runProbe(fixture, limit);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as ProbeResource[];
}

function writeBundle(
  directory: string,
  output: Record<string, unknown> | string,
  validationError?: string,
): string {
  mkdirSync(directory, { recursive: true });
  const bundlePath = join(directory, "databricks.yml");
  writeFileSync(bundlePath, "bundle: {}\n");
  writeFileSync(
    join(directory, ".validation-output"),
    typeof output === "string" ? output : JSON.stringify(output),
  );
  if (validationError) {
    writeFileSync(join(directory, ".validation-error"), validationError);
  }
  return bundlePath;
}
