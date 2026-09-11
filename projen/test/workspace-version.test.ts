import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateBarrels } from "../src/barrels.ts";
import { DBXToolsNodeProject } from "../src/project.ts";
import { resolveNextVersion, writeWorkspaceVersion } from "../src/workspace-version.ts";

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
      assert.deepEqual(resolveNextVersion(outdir, ["v"], "minor", { fetch: false }), {
        base: "1.2.3",
        version: "1.3.0",
        source: "local",
      });
      assert.equal(readFileSync(join(outdir, "VERSION"), "utf8"), "1.2.3\n");
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
