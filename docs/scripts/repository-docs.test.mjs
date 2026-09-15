import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  discoverJavaScriptPackages,
  discoverPythonPackages,
  discoverRepositoryPackages,
  discoverRustPackages,
  summaryText,
  withBasePath,
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
  mkdirSync(join(root, "packages/rs/model/src"), { recursive: true });
  writeFileSync(
    join(root, "packages/rs/model/Cargo.toml"),
    '[package]\nname = "dbx-tools-model"\n\n[lib]\nname = "dbx_model"\n',
  );
  writeFileSync(join(root, "packages/rs/model/src/lib.rs"), "pub fn model() {}\n");
  writeFileSync(join(root, "packages/rs/model/README.md"), "# Model\n\nModel docs.\n");
  return root;
}

describe("repository docs catalogue", () => {
  it("discovers one shared JavaScript, Python, and Rust package set", () => {
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
      discoverRustPackages(root).map((pkg) => pkg.rustdocTarget),
      ["dbx_model"],
    );
    assert.deepEqual(
      discoverRepositoryPackages(root).map((pkg) => pkg.group),
      ["python", "rust", "ui"],
    );
  });

  it("shares summary and base-path behavior", () => {
    assert.equal(summaryText("# Title\n\nUse [`Widget`](./widget.md) now."), "Use Widget now.");
    assert.equal(withBasePath("/docs", "/api/widget/"), "/docs/api/widget/");
    assert.equal(withBasePath("/docs", "/docs/api/widget/"), "/docs/api/widget/");
  });
});
