import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  missingDependencies,
  resolveDependencies,
  resolveVersion,
} from "../src/dependency-resolver.ts";

const leftpad = {
  name: "leftpad",
  versions: ["1.0.0", "1.1.0"],
  latest: "1.1.0",
  dependencies: { "1.0.0": {}, "1.1.0": {} },
};

const typescript = {
  name: "typescript",
  versions: ["5.8.3"],
  latest: "5.8.3",
  dependencies: { "5.8.3": {} },
};

const parent = {
  name: "parent",
  versions: ["2.0.0"],
  latest: "2.0.0",
  dependencies: { "2.0.0": { child: "^2.0.0" } },
};

const child = {
  name: "child",
  versions: ["1.0.0"],
  latest: "1.0.0",
  dependencies: { "1.0.0": {} },
};

const catalog = async (name: string) => {
  if (name === "leftpad") return leftpad;
  if (name === "typescript") return typescript;
  if (name === "parent") return parent;
  if (name === "child") return child;
  return undefined;
};

describe("resolveVersion", () => {
  it("returns the same exact version when it exists", async () => {
    const resolved = await resolveVersion("typescript@5.8.3", {
      packageInfo: async () => typescript,
    });
    assert.deepEqual(resolved, { name: "typescript", version: "5.8.3" });
  });

  it("accepts a name plus raw specifier string", async () => {
    const resolved = await resolveVersion("leftpad", "^1.0.0", {
      packageInfo: async () => leftpad,
    });
    assert.deepEqual(resolved, { name: "leftpad", version: "1.1.0", range: "^1.0.0" });
  });

  it("accepts a structured dependency object", async () => {
    const resolved = await resolveVersion(
      { name: "leftpad", version: "1.0.0", range: "^1.0.0" },
      { packageInfo: async () => leftpad },
    );
    assert.deepEqual(resolved, { name: "leftpad", version: "1.0.0", range: "^1.0.0" });
  });

  it("reads semver as a version alias", async () => {
    const resolved = await resolveVersion(
      { name: "typescript", semver: "5.8.3" },
      { packageInfo: async () => typescript },
    );
    assert.deepEqual(resolved, { name: "typescript", version: "5.8.3" });
  });

  it("falls back to an available version when the exact request is missing", async () => {
    const resolved = await resolveVersion(
      { name: "leftpad", version: "2.0.0" },
      { packageInfo: async () => leftpad },
    );
    assert.deepEqual(resolved, { name: "leftpad", version: "1.1.0" });
  });
});

describe("missingDependencies", () => {
  it("returns declared packages whose specifier is not in the registry", async () => {
    const missing = await missingDependencies(
      { dependencies: { leftpad: "^1.0.0", gone: "2.0.0" } },
      { packageInfo: catalog },
    );
    assert.deepEqual(missing, [{ name: "gone", version: "2.0.0" }]);
  });

  it("returns a transitive hole when the direct dependency exists", async () => {
    const missing = await missingDependencies(
      { dependencies: { parent: "2.0.0" } },
      { packageInfo: catalog },
    );
    assert.deepEqual(missing, [{ name: "child", range: "^2.0.0" }]);
  });

  it("returns an empty list when the packument graph is complete", async () => {
    const missing = await missingDependencies(
      { dependencies: { leftpad: { range: "^1.0.0" } } },
      { packageInfo: catalog },
    );
    assert.deepEqual(missing, []);
  });
});

describe("resolveDependencies", () => {
  it("returns structured versions and ranges for a complete graph", async () => {
    const manifest = {
      name: "demo",
      dependencies: { leftpad: "^1.0.0" },
      devDependencies: { typescript: "5.8.3" },
    };

    const resolved = await resolveDependencies(manifest, { packageInfo: catalog });

    assert.deepEqual(resolved, {
      dependencies: { leftpad: { name: "leftpad", version: "1.1.0", range: "^1.0.0" } },
      devDependencies: { typescript: { name: "typescript", version: "5.8.3" } },
      optionalDependencies: {},
      peerDependencies: {},
      overrides: {},
    });
    assert.equal(manifest.dependencies.leftpad, "^1.0.0");
  });

  it("accepts structured dependency objects in the manifest", async () => {
    const manifest = {
      dependencies: {
        leftpad: { range: "^1.0.0" },
        typescript: { name: "typescript", semver: "5.8.3" },
      },
    };

    const resolved = await resolveDependencies(manifest, { packageInfo: catalog });

    assert.deepEqual(resolved.dependencies.leftpad, {
      name: "leftpad",
      version: "1.1.0",
      range: "^1.0.0",
    });
    assert.deepEqual(resolved.dependencies.typescript, {
      name: "typescript",
      version: "5.8.3",
    });
  });

  it("pins a missing transitive from registry versions without mutating the input", async () => {
    const manifest = {
      dependencies: { parent: "2.0.0" },
    };

    const resolved = await resolveDependencies(manifest, { packageInfo: catalog });

    assert.deepEqual(resolved.dependencies.parent, { name: "parent", version: "2.0.0" });
    assert.deepEqual(resolved.overrides.child, { name: "child", version: "1.0.0" });
    assert.equal(manifest.dependencies.parent, "2.0.0");
    assert.equal("overrides" in manifest, false);
  });

  it("keeps a declared range when a matching version is pinned", async () => {
    const manifest = {
      dependencies: { leftpad: { range: "^1.0.0" } },
    };

    const resolved = await resolveDependencies(manifest, { packageInfo: catalog });

    assert.deepEqual(resolved.dependencies.leftpad, {
      name: "leftpad",
      version: "1.1.0",
      range: "^1.0.0",
    });
  });
});
