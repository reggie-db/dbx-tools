import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Project } from "projen";

import { DBXToolsNodeProject } from "../src/project-js.ts";
import { DBXToolsPythonWorkspace } from "../src/project-py.ts";
import { DBXToolsRustWorkspace } from "../src/project-rs.ts";
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

  it("groups polyglot projects and virtual artifacts into one unit", () => {
    const { outdir, root, catalog } = fixture();
    try {
      const rust = child(root, "packages/rs/core", "pub fn core() {}");
      const node = child(root, "packages/js/core-rs", "export const binding = true;");
      const python = child(root, "packages/py/core-rs", "VALUE = True");
      catalog.addUnit({
        id: "rs-core",
        component: "rs-core",
        projectPaths: ["packages/rs/core", "packages/js/core-rs", "packages/py/core-rs"],
      });
      catalog.registerProject(rust, { language: "rust", identity: "dbx-tools-core" });
      catalog.registerProject(node, {
        language: "javascript",
        identity: "@dbx-tools/core-rs",
      });
      catalog.registerProject(python, {
        language: "python",
        identity: "dbx-tools-core-rs",
      });
      catalog.registerArtifact("rs-core", {
        id: "rs-core:native-npm",
        kind: "npm",
        name: "@dbx-tools/core-rs-linux-x64-gnu",
        generated: true,
      });

      const graph = catalog.graph();
      assert.equal(graph.units.length, 1);
      assert.deepEqual(graph.units[0]?.projects, [
        "packages/js/core-rs",
        "packages/py/core-rs",
        "packages/rs/core",
      ]);
      assert.equal(graph.artifacts[0]?.unit, "rs-core");
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
    assert.equal(defaultReleaseUnitId("rust", "dbx-tools-model"), "rs-model");
    assert.equal(defaultReleasePropagation("runtime"), "outside-range");
    assert.equal(defaultReleasePropagation("generated"), "always");
    assert.equal(defaultReleasePropagation("development"), "never");
  });

  it("renders the root VERSION across Node, Python, and Rust packages", () => {
    const outdir = mkdtempSync(join(tmpdir(), "release-catalog-polyglot-"));
    const previousDisablePost = process.env.PROJEN_DISABLE_POST;
    process.env.PROJEN_DISABLE_POST = "1";
    try {
      writeFileSync(join(outdir, "VERSION"), "3.1.4\n");
      mkdirSync(join(outdir, "packages/js/tool/src"), { recursive: true });
      writeFileSync(join(outdir, "packages/js/tool/src/tool.ts"), "export const tool = true;\n");
      mkdirSync(join(outdir, "packages/rs/core/src"), { recursive: true });
      writeFileSync(join(outdir, "packages/rs/core/src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
      const project = new DBXToolsNodeProject({
        name: "@dbx-tools/root",
        scope: "dbx-tools",
        outdir,
        packageRoots: ["packages/js"],
        defaultTagMixins: false,
        releaseMode: "disabled",
        repository: "https://github.com/example/repository.git",
      });
      new DBXToolsRustWorkspace(project, {
        packages: { core: {} },
        release: false,
      });
      new DBXToolsPythonWorkspace(project, {
        root: "packages/py",
        repository: {
          url: "https://github.com/example/repository.git",
          ref: "main",
        },
        packages: [
          {
            directory: "core",
            name: "dbx-tools-core",
            module: "dbx_tools.core",
            description: "Core fixture",
          },
        ],
      });
      project.synth();

      const rootManifest = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
        version: string;
      };
      const packageManifest = JSON.parse(
        readFileSync(join(outdir, "packages/js/tool/package.json"), "utf8"),
      ) as { version: string };
      const python = readFileSync(join(outdir, "packages/py/core/pyproject.toml"), "utf8");
      const rust = readFileSync(join(outdir, "packages/rs/core/Cargo.toml"), "utf8");
      const rootCargo = readFileSync(join(outdir, "Cargo.toml"), "utf8");
      const publisherInstructions = readFileSync(
        join(outdir, ".projen/pypi-trusted-publisher-instructions.mjs"),
        "utf8",
      );
      assert.equal(rootManifest.version, "3.1.4");
      assert.equal(packageManifest.version, "3.1.4");
      assert.match(python, /version = "3\.1\.4"/);
      assert.match(rust, /\[package\.version\][\s\S]*workspace = true/);
      assert.match(rootCargo, /\[workspace\.package\][\s\S]*version = "3\.1\.4"/);
      assert.match(publisherInstructions, /GitHub environment tag: v\*/);
    } finally {
      if (previousDisablePost === undefined) delete process.env.PROJEN_DISABLE_POST;
      else process.env.PROJEN_DISABLE_POST = previousDisablePost;
      rmSync(outdir, { recursive: true, force: true });
    }
  });
});
