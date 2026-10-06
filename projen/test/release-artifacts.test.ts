import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pythonDistributionPaths } from "../tasks/publish-python.ts";

describe("shared release artifacts", () => {
  it("builds all Python packages once into independent publication directories", () => {
    const root = mkdtempSync(join(tmpdir(), "release-python-artifacts-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const directory of ["core", "app"]) {
        const packageRoot = join(root, "packages", directory);
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(
          join(packageRoot, "pyproject.toml"),
          `[project]\nname = "fixture-${directory}"\nversion = "1.2.3"\n`,
        );
      }
      writeFileSync(
        join(bin, "uv"),
        [
          "#!/bin/sh",
          'test "$1" = build && test "$2" = --out-dir || exit 1',
          'mkdir -p "$3"',
          'name=$(basename "$4")',
          'touch "$3/$name-1.2.3-py3-none-any.whl" "$3/$name-1.2.3.tar.gz"',
          `printf '%s\\n' "$name" >> "${join(root, "builds")}"`,
        ].join("\n"),
      );
      writeFileSync(
        join(bin, "uvx"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "checks")}"\n`,
      );
      chmodSync(join(bin, "uv"), 0o755);
      chmodSync(join(bin, "uvx"), 0o755);
      const output = join(root, "dist");
      const owner = resolve(import.meta.dirname, "../tasks/publish-python.ts");
      const options = {
        root: join(root, "packages"),
        output,
        packageDirectories: true,
        version: "1.2.3",
      };
      execFileSync(
        process.execPath,
        [
          "--eval",
          `import { buildPythonProjects } from ${JSON.stringify(owner)}; buildPythonProjects(${JSON.stringify(options)});`,
        ],
        {
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        },
      );
      assert.deepEqual(readFileSync(join(root, "builds"), "utf8").trim().split("\n"), [
        "app",
        "core",
      ]);
      assert.equal(pythonDistributionPaths(join(output, "core")).length, 2);
      assert.equal(pythonDistributionPaths(join(output, "app")).length, 2);
      assert.equal(pythonDistributionPaths(output).length, 0);
      const checks = readFileSync(join(root, "checks"), "utf8").trim().split("\n");
      assert.deepEqual(checks.slice(0, 2), ["twine", "check"]);
      assert.equal(checks.length, 6);
      for (const directory of ["core", "app"]) {
        assert.equal(
          readFileSync(join(root, "packages", directory, "pyproject.toml"), "utf8"),
          `[project]\nname = "fixture-${directory}"\nversion = "1.2.3"\n`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the bundled npm publisher without a checkout or workspace dependencies", () => {
    const root = mkdtempSync(join(tmpdir(), "release-npm-artifacts-"));
    try {
      const bin = join(root, "bin");
      const output = join(root, "archives");
      const packageRoot = join(root, "package");
      mkdirSync(bin);
      mkdirSync(output);
      mkdirSync(packageRoot);
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/core",
          version: "1.2.3",
          publishConfig: { access: "public" },
        }),
      );
      execFileSync("tar", ["-czf", join(output, "core.tgz"), "-C", root, "package"]);
      const publisher = join(output, "publish-npm.mjs");
      execFileSync(
        process.execPath,
        [
          "build",
          resolve(import.meta.dirname, "../tasks/publish-npm.ts"),
          "--target=bun",
          `--outfile=${publisher}`,
        ],
        { cwd: root },
      );
      writeFileSync(
        join(bin, "npm"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "publish-args")}"\n`,
      );
      chmodSync(join(bin, "npm"), 0o755);
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
      execFileSync(
        process.execPath,
        [publisher, "--directory", output, "--version", "1.2.3", "--dry-run"],
        { cwd: root, env },
      );
      assert.deepEqual(readFileSync(join(root, "publish-args"), "utf8").trim().split("\n"), [
        "publish",
        join(output, "core.tgz"),
        "--access",
        "public",
        "--dry-run",
      ]);
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [publisher, "--directory", output, "--version", "9.9.9", "--dry-run"],
            { cwd: root, env, stdio: "pipe" },
          ),
        /expected 9\.9\.9/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
