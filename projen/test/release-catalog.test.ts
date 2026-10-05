import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Project } from "projen";

import { DBXToolsNodeProject } from "../src/project-js.ts";
import { DBXToolsPythonWorkspace } from "../src/project-py.ts";
import {
  DBXToolsReleaseCatalog,
  defaultReleasePropagation,
  defaultReleaseUnitId,
  publicationBatches,
} from "../src/release-catalog.ts";

function fixture(): { outdir: string; root: Project; catalog: DBXToolsReleaseCatalog } {
  const outdir = mkdtempSync(join(tmpdir(), "release-catalog-"));
  writeFileSync(join(outdir, "VERSION"), "1.2.3\n");
  const root = new Project({ name: "root", outdir });
  const catalog = new DBXToolsReleaseCatalog(root);
  return { outdir, root, catalog };
}

function child(root: Project, path: string, source: string): Project {
  const project = new Project({ name: path.replaceAll("/", "-"), parent: root, outdir: path });
  mkdirSync(join(project.outdir, "src"), { recursive: true });
  writeFileSync(join(project.outdir, "src/index.ts"), `${source}\n`);
  return project;
}

describe("DBXToolsReleaseCatalog", () => {
  it("normalizes project ownership, dependencies, versions, and publication batches", () => {
    const { outdir, root, catalog } = fixture();
    try {
      const core = child(root, "packages/core", "export const core = true;");
      const app = child(root, "packages/app", "export const app = true;");
      catalog.registerProject(core, {
        language: "javascript",
        identity: "@example/core",
      });
      catalog.registerProject(app, {
        language: "javascript",
        identity: "@example/app",
        dependencies: [
          {
            target: "@example/core",
            kind: "runtime",
            requirement: "^1.2.0",
            internal: true,
          },
        ],
      });

      const graph = catalog.graph();
      assert.deepEqual(
        graph.units.map(({ id, version }) => ({ id, version })),
        [
          { id: "node-app", version: "1.2.3" },
          { id: "node-core", version: "1.2.3" },
        ],
      );
      assert.deepEqual(graph.publishBatches, [["node-core"], ["node-app"]]);
      assert.deepEqual(graph.edges, [
        {
          from: "node-app",
          to: "node-core",
          kind: "runtime",
          requirement: "^1.2.0",
          propagation: "outside-range",
          publishOrder: true,
        },
      ]);
      assert.notEqual(graph.units[0]?.sourceHash, graph.units[1]?.sourceHash);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("includes explicitly registered external workspace members", () => {
    const { outdir, catalog } = fixture();
    try {
      mkdirSync(join(outdir, "projen/src"), { recursive: true });
      writeFileSync(join(outdir, "projen/src/index.ts"), "export const engine = true;\n");
      catalog.registerExternalProject({
        path: "projen",
        language: "javascript",
        identity: "@example/projen",
      });

      const graph = catalog.graph();
      assert.equal(graph.projects[0]?.id, "projen");
      assert.equal(graph.units[0]?.id, "node-projen");
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("rejects unknown internal projects and publication cycles", () => {
    const { outdir, root, catalog } = fixture();
    try {
      const app = child(root, "packages/app", "export const app = true;");
      catalog.registerProject(app, {
        language: "javascript",
        identity: "@example/app",
        dependencies: [{ target: "@example/missing", kind: "runtime", internal: true }],
      });
      assert.throws(() => catalog.graph(), /unknown internal project/);
      assert.throws(
        () =>
          publicationBatches(
            ["a", "b"],
            [
              { from: "a", to: "b", publishOrder: true },
              { from: "b", to: "a", publishOrder: true },
            ],
          ),
        /Cyclic release publication dependencies/,
      );
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  it("pins default unit and propagation policies", () => {
    assert.equal(defaultReleaseUnitId("javascript", "@example/search"), "node-search");
    assert.equal(defaultReleaseUnitId("python", "example-postgres"), "python-example-postgres");
    assert.equal(defaultReleasePropagation("runtime"), "outside-range");
    assert.equal(defaultReleasePropagation("generated"), "always");
    assert.equal(defaultReleasePropagation("development"), "never");
  });
});
