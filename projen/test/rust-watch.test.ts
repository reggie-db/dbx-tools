import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RustWorkspaceMapping } from "../src/project-rs.ts";
import { rustStructureChanged } from "../tasks/rust.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { root: string; config: RustWorkspaceMapping } {
  const root = mkdtempSync(join(tmpdir(), "rust-watch-"));
  directories.push(root);
  mkdirSync(join(root, "auth-u2m/src"), { recursive: true });
  writeFileSync(join(root, "auth-u2m/src/lib.rs"), "uniffi::setup_scaffolding!();\n");
  return {
    root,
    config: {
      root,
      crates: [`${root}/auth-u2m`],
      bindings: [
        {
          crate: "fixture-auth-u2m",
          rust: `${root}/auth-u2m`,
          node: "packages/js/node/auth-u2m",
          python: "packages/py/auth-u2m",
        },
      ],
    },
  };
}

describe("Rust watch structure detection", () => {
  it("keeps ordinary UniFFI source edits on the targeted generation path", () => {
    const { root, config } = fixture();
    writeFileSync(
      join(root, "auth-u2m/src/lib.rs"),
      "#[uniffi::export]\npub fn value() {}\nuniffi::setup_scaffolding!();\n",
    );
    assert.equal(rustStructureChanged(config), false);
  });

  it("requires synth when the UniFFI marker is removed", () => {
    const { root, config } = fixture();
    writeFileSync(join(root, "auth-u2m/src/lib.rs"), "pub fn value() {}\n");
    assert.equal(rustStructureChanged(config), true);
  });

  it("requires synth when a Rust crate is added", () => {
    const { root, config } = fixture();
    mkdirSync(join(root, "other/src"), { recursive: true });
    writeFileSync(join(root, "other/src/lib.rs"), "pub fn value() {}\n");
    assert.equal(rustStructureChanged(config), true);
  });
});
