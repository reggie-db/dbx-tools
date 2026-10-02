import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cargoIndexDependency, type CargoDependency } from "../tasks/package-cargo.ts";

const dependency = {
  features: [],
  kind: null,
  name: "fixture-core",
  optional: false,
  registry: null,
  rename: null,
  req: "^1.2.3",
  target: null,
  uses_default_features: true,
} satisfies Omit<CargoDependency, "source">;

describe("Cargo sparse index packaging", () => {
  it("leaves workspace dependencies in the current registry", () => {
    assert.equal(
      cargoIndexDependency({ ...dependency, source: null }, new Set(["fixture-core"])).registry,
      "self",
    );
  });

  it("routes registry dependencies back to crates.io", () => {
    assert.equal(
      cargoIndexDependency(
        {
          ...dependency,
          source: "registry+https://github.com/rust-lang/crates.io-index",
        },
        new Set(),
      ).registry,
      "https://github.com/rust-lang/crates.io-index",
    );
  });
});
