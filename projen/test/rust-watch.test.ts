import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RustWorkspaceMapping } from "../src/project-rs.ts";
import {
  affectedRustBindings,
  changedRustBindings,
  changedRustOwners,
  rustStructureChanged,
} from "../tasks/rust.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { root: string; config: RustWorkspaceMapping } {
  const root = mkdtempSync(join(tmpdir(), "rust-watch-"));
  directories.push(root);
  mkdirSync(join(root, "databricks-auth/src"), { recursive: true });
  writeFileSync(join(root, "databricks-auth/src/lib.rs"), "uniffi::setup_scaffolding!();\n");
  return {
    root,
    config: {
      root,
      crates: [`${root}/databricks-auth`],
      bindings: [
        {
          crate: "fixture-databricks-auth",
          rust: `${root}/databricks-auth`,
          node: "packages/js/node/databricks-auth-rs",
          python: "packages/py/databricks-auth-rs",
          pythonModule: "fixture.databricks_auth_rs",
        },
      ],
      binaries: [],
      openapi: [],
    },
  };
}

describe("Rust watch structure detection", () => {
  it("rebuilds shared bindings before dependent native libraries", () => {
    const bindings = [
      { crate: "consumer", rust: "consumer", dependencies: ["shared"] },
      { crate: "shared", rust: "shared" },
      { crate: "unrelated", rust: "unrelated" },
    ];
    assert.deepEqual(
      affectedRustBindings(bindings, new Set(["shared"])).map((binding) => binding.crate),
      ["shared", "consumer"],
    );
    assert.deepEqual(
      affectedRustBindings(bindings, new Set(["consumer"])).map((binding) => binding.crate),
      ["consumer"],
    );
  });

  it("checks for an owned UniFFI path without walking dependents", () => {
    const config: RustWorkspaceMapping = {
      root: "packages/rs",
      crates: ["packages/rs/shared", "packages/rs/consumer", "packages/rs/unrelated"],
      bindings: [
        { crate: "consumer", rust: "packages/rs/consumer", dependencies: ["shared"] },
        { crate: "shared", rust: "packages/rs/shared" },
        { crate: "unrelated", rust: "packages/rs/unrelated" },
      ],
      binaries: [],
      openapi: [],
    };
    const changed = ["packages/rs/shared/src/lib.rs"];
    assert.equal(
      changedRustOwners(config, changed).some(() => true),
      true,
    );
    assert.deepEqual(
      changedRustBindings(config, changed)
        .map((binding) => binding.crate)
        .toArray(),
      ["shared", "consumer"],
    );
    const unrelated = ["packages/rs/service/src/lib.rs"];
    assert.equal(
      changedRustOwners(config, unrelated).some(() => true),
      false,
    );
    assert.deepEqual(changedRustBindings(config, unrelated).toArray(), []);
  });
  it("keeps ordinary UniFFI source edits on the targeted generation path", () => {
    const { root, config } = fixture();
    writeFileSync(
      join(root, "databricks-auth/src/lib.rs"),
      "#[uniffi::export]\npub fn value() {}\nuniffi::setup_scaffolding!();\n",
    );
    assert.equal(rustStructureChanged(config), false);
  });

  it("requires synth when the UniFFI marker is removed", () => {
    const { root, config } = fixture();
    writeFileSync(join(root, "databricks-auth/src/lib.rs"), "pub fn value() {}\n");
    assert.equal(rustStructureChanged(config), true);
  });

  it("requires synth when a Rust crate is added", () => {
    const { root, config } = fixture();
    mkdirSync(join(root, "other/src"), { recursive: true });
    writeFileSync(join(root, "other/src/lib.rs"), "pub fn value() {}\n");
    assert.equal(rustStructureChanged(config), true);
  });
});
