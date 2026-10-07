import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { PYTHON_GENERATED_PACKAGE, PYTHON_SYNC_PACKAGE } from "../src/generated.ts";
import { main } from "../tasks/python-sync.ts";

const MODULE_NAME = "fixture.runtime";
const SYNC_PACKAGE = [MODULE_NAME, PYTHON_GENERATED_PACKAGE, PYTHON_SYNC_PACKAGE].join(".");

/** Directory `python-sync` writes the named source to beneath a fixture project. */
function syncDirectory(project: string, name: string): string {
  return join(project, "src", ...SYNC_PACKAGE.split("."), name);
}

describe("Python source sync", () => {
  it("uses check-lock-check and writes read-only generated files", async () => {
    const { root, upstream, commit } = fixtureRepository({
      "driver/driver.py": "value = 1\n",
      "driver/tests/test_driver.py": "ignored = True\n",
    });
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "pyproject.toml"),
      [
        "[tool.uv.build-backend]",
        `module-name = "${MODULE_NAME}"`,
        'module-root = "src"',
        "",
        "[[tool.dbx_tools.sync]]",
        'name = "driver"',
        `source = "fixture @ git+${upstream}@${commit}#subdirectory=driver"`,
        'include = ["**/*.py"]',
        'exclude = ["tests/**"]',
        "",
      ].join("\n"),
    );

    await main(["--project", project]);
    const target = syncDirectory(project, "driver");
    assert.equal(readFileSync(join(target, "driver.py"), "utf8"), "value = 1\n");
    assert.equal(statSync(join(target, "driver.py")).mode & 0o222, 0);
    assert.equal(statSync(target).mode & 0o222, 0);
    assert.equal(existsSync(join(target, "tests")), false);

    chmodSync(target, 0o755);
    await main(["--project", project]);
    assert.equal(statSync(target).mode & 0o222, 0o200);
    await main(["--project", project, "--force"]);
    assert.equal(statSync(target).mode & 0o222, 0);
    await assert.doesNotReject(main(["--project", project, "--check"]));
  });

  it("localizes absolute imports of synchronized modules", async () => {
    const { root, upstream, commit } = fixtureRepository({
      "lib/vendor/__init__.py": "",
      "lib/vendor/config/__init__.py": "",
      "lib/vendor/config/schema.py": "Value = 1\n",
      "lib/vendor/helpers.py": "def helper():\n    return 1\n",
      "lib/vendor/driver.py": [
        "import os, config.schema",
        "import config",
        "import config.schema as schema_alias",
        "from config.schema import (",
        "    Value,  # kept",
        ")",
        "from lib.vendor.helpers import helper",
        "from lib.other import untouched",
        "from . import helpers",
        "",
        "",
        "def load():",
        "    import importlib",
        "",
        "    return __import__('lib.vendor.helpers', fromlist=['helper']), importlib.import_module(\"config\")",
        "",
      ].join("\n"),
    });
    const project = fixtureProject(root, "auto", upstream, commit);
    await main(["--project", project]);
    const local = `${SYNC_PACKAGE}.vendor`;
    assert.equal(
      readFileSync(join(syncDirectory(project, "vendor"), "driver.py"), "utf8"),
      [
        `import os; import ${local}.config.schema; from ${local} import config`,
        `from ${local} import config`,
        `import ${local}.config.schema as schema_alias`,
        `from ${local}.config.schema import (`,
        "    Value,  # kept",
        ")",
        `from ${local}.helpers import helper`,
        "from lib.other import untouched",
        "from . import helpers",
        "",
        "",
        "def load():",
        "    import importlib",
        "",
        `    return __import__('${local}.helpers', fromlist=['helper']), importlib.import_module("${local}.config")`,
        "",
      ].join("\n"),
    );

    const disabled = fixtureProject(root, "disabled", upstream, commit, "localize_imports = false");
    await main(["--project", disabled]);
    assert.match(
      readFileSync(join(syncDirectory(disabled, "vendor"), "driver.py"), "utf8"),
      /^import os, config\.schema$/m,
    );

    const listed = fixtureProject(
      root,
      "listed",
      upstream,
      commit,
      'localize_imports = ["config"]',
    );
    await main(["--project", listed]);
    const listedDriver = readFileSync(join(syncDirectory(listed, "vendor"), "driver.py"), "utf8");
    assert.match(
      listedDriver,
      new RegExp(`^from ${local.replaceAll(".", "\\.")} import config$`, "m"),
    );
    assert.match(listedDriver, /^from lib\.vendor\.helpers import helper$/m);

    for (const [name, module, error] of [
      ["outside", "lib.other", /localize_imports module 'lib\.other' is not synchronized/],
      ["unmatched", "helpers", /localize_imports did not match .*: helpers/],
    ] as const) {
      const rejected = fixtureProject(
        root,
        name,
        upstream,
        commit,
        `localize_imports = ["${module}"]`,
      );
      await assert.rejects(main(["--project", rejected]), error);
    }
  });
});

function fixtureRepository(files: Readonly<Record<string, string>>): {
  readonly root: string;
  readonly upstream: string;
  readonly commit: string;
} {
  const root = mkdtempSync(join(tmpdir(), "python-sync-"));
  const upstream = join(root, "upstream");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(upstream, path)), { recursive: true });
    writeFileSync(join(upstream, path), contents);
  }
  execFileSync("git", ["init", "--quiet", upstream]);
  execFileSync("git", ["-C", upstream, "add", "."]);
  execFileSync("git", [
    "-C",
    upstream,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const commit = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { root, upstream, commit };
}

function fixtureProject(
  root: string,
  name: string,
  upstream: string,
  commit: string,
  ...options: string[]
): string {
  const project = join(root, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "pyproject.toml"),
    [
      "[tool.uv.build-backend]",
      `module-name = "${MODULE_NAME}"`,
      "",
      "[[tool.dbx_tools.sync]]",
      'name = "vendor"',
      `source = "fixture @ git+${upstream}@${commit}#subdirectory=lib/vendor"`,
      'include = ["**/*.py"]',
      ...options,
      "",
    ].join("\n"),
  );
  return project;
}
