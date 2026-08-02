import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

/**
 * Synthesize a root with one codegen package that holds BOTH a generated module
 * and a hand-written one - the shape that distinguishes a per-module ignore from
 * a blanket `src/**` ignore.
 */
function synthIgnorePatterns(): string[] {
  process.env.PROJEN_DISABLE_POST = "1";
  const outdir = mkdtempSync(join(tmpdir(), "codegen-eslint-"));
  const root = new DBXToolsNodeProject({ name: "codegen-eslint-fixture", outdir });
  const pkgDir = join(outdir, "packages/shared/generated");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(join(pkgDir, "src/dashboards.ts"), "export const generated = 1;\n");
  writeFileSync(join(pkgDir, "src/hand-written.ts"), "export const handWritten = 1;\n");
  const pkg = new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/shared/generated",
    name: "@fixture/generated",
  });
  pkg.package.addField("codegen", {
    inputs: ["node_modules/some-sdk/dist/apis/dashboards/model.d.ts"],
  });
  root.synth();

  const raw = readFileSync(join(outdir, ".eslintrc.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  return (JSON.parse(raw) as { ignorePatterns: string[] }).ignorePatterns;
}

describe("codegen eslint ignores", () => {
  const patterns = synthIgnorePatterns();

  // Generated modules are written read-only, and the lint task runs with `--fix`,
  // which EACCES-crashes on a read-only file. So they have to be ignored.
  it("ignores the module a codegen input generates", () => {
    assert.ok(
      patterns.includes("packages/shared/generated/src/dashboards.ts"),
      `expected the generated module to be ignored, got ${JSON.stringify(patterns)}`,
    );
  });

  // The ignore used to be a blanket `<pkg>/src/**`, which assumed a codegen package
  // is ENTIRELY generated. It is not: shared-genie generates `dashboards.ts` next to
  // a hand-written `genie-model.ts`. A blanket ignore stops linting the hand-written
  // module, and the symptom is invisible - ESLint simply reports fewer problems.
  it("does not ignore a hand-written module in the same package", () => {
    assert.equal(patterns.includes("packages/shared/generated/src/**"), false);
    for (const pattern of patterns) {
      assert.equal(
        pattern.endsWith("/src/**") && pattern.startsWith("packages/shared/generated"),
        false,
        `blanket ignore would skip hand-written sources: ${pattern}`,
      );
    }
  });
});
