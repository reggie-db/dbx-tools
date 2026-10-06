/**
 * Projen owns each child `.gitignore`, including native defaults and custom
 * patterns. The engine only protects the caller's options from Projen's mutable
 * array alias.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

let outdir: string;
const callerPatterns = ["/seeded-via-options/"];

const read = (rel: string): string[] =>
  readFileSync(join(outdir, rel), "utf8").trimEnd().split("\n");

before(() => {
  process.env.PROJEN_DISABLE_POST = "1"; // no install/barrels during synth
  outdir = mkdtempSync(join(tmpdir(), "child-gitignore-"));

  const root = new DBXToolsNodeProject({
    name: "gitignore-fixture",
    outdir,
    defaultTagMixins: false,
  });
  const withCustom = new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/with-custom",
    name: "@fixture/with-custom",
  });
  withCustom.gitignore.addPatterns("/generated-artifacts/");
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/no-custom",
    name: "@fixture/no-custom",
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "packages/via-options",
    name: "@fixture/via-options",
    gitignore: ["/from-gitignore-opt/"],
    gitIgnoreOptions: { ignorePatterns: callerPatterns },
  });
  root.synth();
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("child .gitignore", () => {
  it("keeps native defaults and custom patterns added after construction", () => {
    const lines = read("packages/with-custom/.gitignore");
    assert.ok(lines.includes("/generated-artifacts/"));
    assert.ok(lines.includes("node_modules/"));
  });

  it("emits native defaults without custom patterns", () => {
    assert.ok(existsSync(join(outdir, "packages/no-custom/.gitignore")));
    assert.ok(read("packages/no-custom/.gitignore").includes("node_modules/"));
  });

  it("keeps patterns seeded through the standard Projen options", () => {
    const lines = read("packages/via-options/.gitignore").filter((l) => !l.startsWith("#"));
    assert.ok(lines.includes("/from-gitignore-opt/"));
    assert.ok(lines.includes("/seeded-via-options/"));
    assert.ok(lines.includes("node_modules/"));
  });

  it("leaves the caller's ignorePatterns array unmutated", () => {
    // projen's IgnoreFile aliases the array it is given; the engine must hand it
    // a copy or the defaults land back in the child file via the re-seed.
    assert.deepEqual(callerPatterns, ["/seeded-via-options/"]);
  });

  it("leaves the root's default .gitignore intact", () => {
    const lines = read(".gitignore");
    assert.ok(lines.includes("node_modules/"));
  });
});

describe("root .gitignore dot-path policy", () => {
  it("never blanket-excludes dot-paths", () => {
    // `**/.*` excludes dot-DIRECTORIES, and git will not descend into an
    // excluded directory - which silently voids every `!/.projen/...` negation
    // projen emits to force its generated files INTO git. The damage is
    // invisible (indexed files keep working, new ones are unaddable), so guard
    // the pattern itself rather than waiting for a package to lose its metadata.
    const lines = read(".gitignore");
    assert.ok(!lines.includes("**/.*"), "blanket dot exclusion is back");
    assert.ok(!lines.includes("**/.*/**"), "blanket dot-directory exclusion is back");
  });

  it("still ignores secrets, while keeping the example env trackable", () => {
    const lines = read(".gitignore");
    assert.ok(lines.includes(".env"));
    assert.ok(lines.includes(".env.*"));
    // Negations must come after the pattern they override; last match wins.
    assert.ok(lines.indexOf("!.env.example") > lines.indexOf(".env.*"));
  });

  it("leaves projen's own generated-file negations able to apply", () => {
    // Each negation targets a file inside a dot-directory, so it only works
    // while no pattern excludes that directory.
    const lines = read(".gitignore");
    assert.ok(lines.includes("!/.projen/tasks.json"));
    const excludesDotDir = lines.some((l) => /^\*{0,2}\/?\.\*(\/\*{1,2})?$/.test(l));
    assert.ok(!excludesDotDir, "a pattern excludes dot-directories, voiding negations");
  });
});
