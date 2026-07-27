/**
 * A CHILD's `.gitignore` carries ONLY custom patterns (post-construction
 * `addPatterns`, or the `gitignore`/`gitIgnoreOptions.ignorePatterns` options) -
 * never the NodeProject defaults the root already provides - and is not emitted
 * at all when nothing custom was added. The root keeps its full default file.
 * Also guards the projen quirk that seeded this: IgnoreFile ALIASES the
 * `ignorePatterns` array it is handed, so the caller's options must stay pristine.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project";

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
    outdir: "workspaces/with-custom",
    name: "@fixture/with-custom",
  });
  withCustom.gitignore.addPatterns("/generated-artifacts/");
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "workspaces/no-custom",
    name: "@fixture/no-custom",
  });
  new DBXToolsTypeScriptProject({
    parent: root,
    outdir: "workspaces/via-options",
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
  it("keeps only the custom patterns added after construction", () => {
    const lines = read("workspaces/with-custom/.gitignore");
    assert.ok(lines.includes("/generated-artifacts/"));
    // None of the NodeProject defaults leak in - custom + marker is all there is.
    assert.ok(!lines.includes("node_modules/"));
    assert.equal(lines.filter((l) => !l.startsWith("#")).length, 1);
  });

  it("is not emitted at all without custom patterns", () => {
    assert.ok(!existsSync(join(outdir, "workspaces/no-custom/.gitignore")));
  });

  it("keeps only the patterns seeded through the standard projen options", () => {
    const lines = read("workspaces/via-options/.gitignore").filter((l) => !l.startsWith("#"));
    assert.deepEqual(lines.sort(), ["/from-gitignore-opt/", "/seeded-via-options/"]);
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
