import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateBarrels } from "../src/barrels.ts";
import { DBXToolsNodeProject } from "../src/project.ts";
import {
  parseSemver,
  resolveNextVersion,
  writeWorkspaceVersion,
} from "../src/workspace-version.ts";

describe("stable version parsing", () => {
  it("accepts only an exact stable semantic version", () => {
    assert.deepEqual(parseSemver("1.2.3"), [1, 2, 3]);
    for (const value of ["bad1.2.3", "v1.2.3", "1.2.3-rc.1", "1.2.3+build", "01.2.3"]) {
      assert.equal(parseSemver(value), undefined, value);
    }
  });
});

describe("workspace version synthesis", () => {
  it("synchronizes extra-member manifests before generating barrels", () => {
    const outdir = mkdtempSync(join(tmpdir(), "workspace-version-"));
    process.env.PROJEN_DISABLE_POST = "1";
    try {
      writeWorkspaceVersion(outdir, "9.8.7");
      mkdirSync(join(outdir, "tooling/src"), { recursive: true });
      const manifestPath = join(outdir, "tooling/package.json");
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ name: "@fixture/tooling", version: "1.0.0" }, null, 2)}\n`,
      );
      chmodSync(manifestPath, 0o444);
      writeFileSync(join(outdir, "tooling/src/tool.ts"), "export const tool = true;\n");

      const project = new DBXToolsNodeProject({
        name: "workspace-version-fixture",
        outdir,
        defaultTagMixins: false,
        extraWorkspaceMembers: ["tooling"],
      });
      project.synth();

      const manifest = JSON.parse(readFileSync(join(outdir, "tooling/package.json"), "utf8")) as {
        version: string;
      };
      assert.equal(manifest.version, "9.8.7");
      generateBarrels({ dirs: [join(outdir, "tooling")] });
      assert.match(
        readFileSync(join(outdir, "tooling/index.ts"), "utf8"),
        /PACKAGE_VERSION = "9\.8\.7"/,
      );
    } finally {
      delete process.env.PROJEN_DISABLE_POST;
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("resolves a requested next version without mutating VERSION", () => {
    const outdir = mkdtempSync(join(tmpdir(), "workspace-next-version-"));
    try {
      writeWorkspaceVersion(outdir, "1.2.3");
      assert.deepEqual(resolveNextVersion(outdir, "minor"), {
        base: "1.2.3",
        version: "1.3.0",
      });
      assert.equal(readFileSync(join(outdir, "VERSION"), "utf8"), "1.2.3\n");
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("increments only from the checked-in VERSION file", () => {
    const outdir = mkdtempSync(join(tmpdir(), "workspace-component-version-"));
    try {
      writeWorkspaceVersion(outdir, "0.6.230");
      execFileSync("git", ["init", "-b", "main"], { cwd: outdir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Version Test"], {
        cwd: outdir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "version@example.com"], {
        cwd: outdir,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "VERSION"], { cwd: outdir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: outdir, stdio: "ignore" });
      execFileSync("git", ["tag", "v0.6.230"], { cwd: outdir, stdio: "ignore" });
      execFileSync("git", ["tag", "projen-cli-v0.9.2"], { cwd: outdir, stdio: "ignore" });
      assert.deepEqual(resolveNextVersion(outdir, "patch"), {
        base: "0.6.230",
        version: "0.6.231",
      });
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("keeps the bump task free of git and publication side effects", () => {
    const outdir = mkdtempSync(join(tmpdir(), "workspace-bump-"));
    try {
      writeWorkspaceVersion(outdir, "1.2.3");
      writeFileSync(join(outdir, "package.json"), '{"name":"fixture","private":true}\n');
      execFileSync(
        process.execPath,
        [join(import.meta.dirname, "..", "tasks", "bump.ts"), "--level", "minor", "--no-synth"],
        { cwd: outdir, stdio: "pipe" },
      );
      assert.equal(readFileSync(join(outdir, "VERSION"), "utf8"), "1.3.0\n");
      assert.equal(
        readFileSync(join(outdir, "package.json"), "utf8"),
        '{"name":"fixture","private":true}\n',
      );
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
