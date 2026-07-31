import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  clearOsPathsCache,
  expandLocalHomePath,
  isHomeRelativePath,
  resolveLocalRoot,
} from "../src/local-path.ts";
import { LocalFileSystem } from "../src/local-fs.ts";

describe("local-path home expansion", () => {
  it("detects home-relative paths", () => {
    assert.equal(isHomeRelativePath("~"), true);
    assert.equal(isHomeRelativePath("~/data"), true);
    assert.equal(isHomeRelativePath("/tmp"), false);
  });

  it("expands ~ against a home directory", () => {
    assert.equal(expandLocalHomePath("~", "/Users/me"), "/Users/me");
    assert.equal(
      expandLocalHomePath("~/projects/data", "/Users/me"),
      path.join("/Users/me", "projects/data"),
    );
    assert.equal(expandLocalHomePath("./relative", "/Users/me"), "./relative");
  });

  it("resolveLocalRoot expands then path.resolves", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "dbx-resolve-root-"));
    try {
      // Explicit non-process cwd avoids poisoning the process-cwd cache.
      const resolved = resolveLocalRoot("~/workspace", {
        cwd: home,
        env: { HOME: home },
        homeDir: () => "",
      });
      assert.equal(resolved, path.resolve(home, "workspace"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("LocalFileSystem home roots", () => {
  it("accepts ~ roots via HOME", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "dbx-local-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    clearOsPathsCache();
    try {
      const fs = new LocalFileSystem({ root: "~/app-data" });
      await fs.init();
      assert.equal(fs.root, path.resolve(home, "app-data").replace(/\\/g, "/"));
      await fs.writeFile("note.txt", "hi");
      assert.equal(await fs.readFile("note.txt", { encoding: "utf8" }), "hi");
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      clearOsPathsCache();
      await rm(home, { recursive: true, force: true });
    }
  });
});
