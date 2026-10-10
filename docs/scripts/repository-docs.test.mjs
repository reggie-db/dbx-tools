import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  discoverJavaScriptPackages,
  discoverPythonPackages,
  discoverRepositoryPackages,
  escapeRegExp,
  packageReadmeIssues,
  stripLeadingH1,
  summaryText,
  walk,
  withBasePath,
  yamlString,
} from "./repository-docs.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repository-docs-"));
  fixtures.push(root);
  mkdirSync(join(root, "packages/js/ui/widget"), { recursive: true });
  writeFileSync(
    join(root, "packages/js/ui/widget/package.json"),
    JSON.stringify({ name: "@dbx-tools/ui-widget" }),
  );
  writeFileSync(join(root, "packages/js/ui/widget/README.md"), "# Widget\n\nWidget docs.\n");
  mkdirSync(join(root, "packages/js/ui/private"), { recursive: true });
  writeFileSync(
    join(root, "packages/js/ui/private/package.json"),
    JSON.stringify({ name: "@dbx-tools/ui-private", private: true }),
  );
  mkdirSync(join(root, "packages/py/core"), { recursive: true });
  writeFileSync(
    join(root, "packages/py/core/pyproject.toml"),
    '[project]\nname = "dbx-tools-core"\n',
  );
  writeFileSync(join(root, "packages/py/core/README.md"), "# Core\n\nCore docs.\n");
  return root;
}

describe("repository docs catalogue", () => {
  it("discovers one shared JavaScript and Python package set", () => {
    const root = fixture();
    assert.deepEqual(
      discoverJavaScriptPackages(root).map((pkg) => pkg.slug),
      ["ui-widget"],
    );
    assert.deepEqual(
      discoverPythonPackages(root).map((pkg) => pkg.name),
      ["dbx-tools-core"],
    );
    assert.deepEqual(
      discoverRepositoryPackages(root).map((pkg) => pkg.group),
      ["python", "ui"],
    );
  });

  it("shares summary and base-path behavior", () => {
    assert.equal(summaryText("# Title\n\nUse [`Widget`](./widget.md) now."), "Use Widget now.");
    assert.equal(withBasePath("/docs", "/api/widget/"), "/docs/api/widget/");
    assert.equal(withBasePath("/docs", "/docs/api/widget/"), "/docs/api/widget/");
    assert.equal(stripLeadingH1("# Title\n\nBody\n"), "Body\n");
    assert.equal(yamlString('A "title"'), '"A \\"title\\""');
    assert.equal(new RegExp(`^${escapeRegExp("a+b")}$`).test("a+b"), true);
  });

  it("reports package guides that are too thin for the docs site", () => {
    assert.deepEqual(packageReadmeIssues("# Widget\n\nShort.\n"), [
      "open with a useful summary of at least 40 characters",
      "include at least two task-oriented H2 sections",
      "include at least one runnable usage example",
    ]);
    assert.deepEqual(
      packageReadmeIssues(
        [
          "# Widget",
          "",
          "Build useful widgets without repeating application setup or transport code.",
          "",
          "## Quick Start",
          "",
          "```ts",
          "createWidget();",
          "```",
          "",
          "## Choose A Mode",
          "",
          "Pick the mode that matches the application.",
        ].join("\n"),
      ),
      [],
    );
  });

  it("reports delayed examples and repository-policy prose", () => {
    const preamble = Array.from({ length: 22 }, (_, index) => `Detail ${index + 1}.`).join("\n");
    assert.deepEqual(
      packageReadmeIssues(
        [
          "# Widget",
          "",
          "Import this package when an application needs widgets without repeated setup.",
          "",
          "## Why Use This Over Native Widgets",
          "",
          "This package owns widget policy. The host does not own it.",
          preamble,
          "",
          "```ts",
          "createWidget();",
          "```",
          "",
          "## Options",
          "",
          "Configure the widget for the host application.",
        ].join("\n"),
      ),
      [
        "show the first runnable usage example within the first 20 lines",
        "describe the user task directly instead of saying 'Import this package when'",
        "move repository ownership policy out of the user guide",
        "use a task or decision heading instead of a defensive 'Why' heading",
      ],
    );
  });

  it("lets callers skip generated output trees", () => {
    const root = fixture();
    mkdirSync(join(root, "packages/js/ui/widget/lib"), { recursive: true });
    writeFileSync(join(root, "packages/js/ui/widget/lib/index.js"), "generated\n");
    assert.equal(
      walk(join(root, "packages/js"), [], ["lib"]).some((file) => file.includes("/lib/")),
      false,
    );
  });
});
