import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

interface Tsconfig {
  compilerOptions: Record<string, unknown>;
  include?: string[];
}

/**
 * Synthesize a root plus two members with DIFFERENT tags, so the assertions can
 * tell a per-tag setting apart from the shared floor.
 */
function synthTsconfigs(): Record<"node" | "shared", Tsconfig> {
  process.env.PROJEN_DISABLE_POST = "1";
  const outdir = mkdtempSync(join(tmpdir(), "tsconfig-jsx-"));
  const root = new DBXToolsNodeProject({ name: "tsconfig-jsx-fixture", outdir });
  for (const tag of ["node", "shared"] as const) {
    new DBXToolsTypeScriptProject({
      parent: root,
      outdir: `packages/${tag}/member`,
      name: `@fixture/${tag}-member`,
    });
  }
  root.synth();

  const read = (tag: string): Tsconfig =>
    JSON.parse(
      readFileSync(join(outdir, `packages/${tag}/member/tsconfig.json`), "utf8").replace(
        /^\s*\/\/.*$/gm,
        "",
      ),
    ) as Tsconfig;
  return { node: read("node"), shared: read("shared") };
}

describe("jsx is part of the shared compiler floor", () => {
  const tsconfigs = synthTsconfigs();

  // Packages resolve each other to SOURCE (`main: index.ts`), so a consumer
  // type-checks its dependency's files under its OWN tsconfig. When any package
  // re-exports a `.tsx` module, every transitive consumer - whatever its tag -
  // fails with `TS6142: ... but '--jsx' is not set`. A non-React tag must
  // therefore still carry `jsx`; it is inert without JSX in the graph.
  it("sets jsx on a non-React package so it can consume a .tsx dependency", () => {
    for (const [tag, tsconfig] of Object.entries(tsconfigs)) {
      assert.equal(tsconfig.compilerOptions.jsx, "react-jsx", `${tag} package is missing jsx`);
    }
  });

  // The floor pairs `jsx` with the `.tsx` include: projen's default include is
  // `src/**/*.ts` only, which OMITS a `.tsx` file from the program silently
  // rather than failing, so a component would go unchecked.
  it("includes .tsx sources without per-package tsconfig config", () => {
    for (const [tag, tsconfig] of Object.entries(tsconfigs)) {
      assert.ok(
        tsconfig.include?.includes("src/**/*.tsx"),
        `${tag} package does not compile .tsx sources`,
      );
    }
  });

  // The floor must not smuggle in a browser environment: an agnostic/node package
  // still has to fail on `document`, which is what the tag `lib`/`types` enforce.
  it("does not add a DOM lib or React types to a non-React package", () => {
    for (const tsconfig of Object.values(tsconfigs)) {
      assert.equal(
        (tsconfig.compilerOptions.lib as string[]).some((lib) => lib.startsWith("DOM")),
        false,
      );
    }
  });
});
