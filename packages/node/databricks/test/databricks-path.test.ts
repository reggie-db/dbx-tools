import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isDbfsPath,
  isHomeRelativePath,
  isVolumesPath,
  isWorkspaceFilesPath,
  normalizeDatabricksRoot,
  resolveDatabricksFilesBackend,
} from "../src/databricks-path.ts";

describe("normalizeDatabricksRoot", () => {
  it("expands catalog.schema.volume to /Volumes/...", () => {
    assert.equal(normalizeDatabricksRoot("main.default.assets"), "/Volumes/main/default/assets");
    assert.equal(
      normalizeDatabricksRoot("  my_catalog.my_schema.my_volume  "),
      "/Volumes/my_catalog/my_schema/my_volume",
    );
  });

  it("normalizes singular /Volume to /Volumes", () => {
    assert.equal(
      normalizeDatabricksRoot("/Volume/main/default/assets"),
      "/Volumes/main/default/assets",
    );
    assert.equal(normalizeDatabricksRoot("/Volume"), "/Volumes");
  });

  it("expands ~ to /Workspace/Users/<userName>", () => {
    assert.equal(
      normalizeDatabricksRoot("~", { userName: "me@example.com" }),
      "/Workspace/Users/me@example.com",
    );
    assert.equal(
      normalizeDatabricksRoot("~/projects/app", { userName: "me@example.com" }),
      "/Workspace/Users/me@example.com/projects/app",
    );
    assert.equal(isHomeRelativePath("~"), true);
    assert.equal(isHomeRelativePath("~/x"), true);
    assert.equal(isHomeRelativePath("/Workspace"), false);
    assert.throws(() => normalizeDatabricksRoot("~"), TypeError);
  });

  it("keeps workspace, volumes, and dbfs roots", () => {
    assert.equal(
      normalizeDatabricksRoot("/Workspace/Users/me@x.com/"),
      "/Workspace/Users/me@x.com",
    );
    assert.equal(normalizeDatabricksRoot("/Volumes/a/b/c/"), "/Volumes/a/b/c");
    assert.equal(normalizeDatabricksRoot("/dbfs/FileStore"), "/dbfs/FileStore");
  });

  it("rejects empty and relative roots", () => {
    assert.throws(() => normalizeDatabricksRoot(""), TypeError);
    assert.throws(() => normalizeDatabricksRoot("relative/path"), TypeError);
    assert.throws(() => normalizeDatabricksRoot("only.two"), TypeError);
  });
});

describe("resolveDatabricksFilesBackend", () => {
  it("routes workspace trees to the workspace API", () => {
    assert.equal(resolveDatabricksFilesBackend("/Workspace/Users/a"), "workspace");
    assert.equal(resolveDatabricksFilesBackend("/Users/a@b.com"), "workspace");
    assert.equal(resolveDatabricksFilesBackend("/Repos/team/repo"), "workspace");
    assert.equal(resolveDatabricksFilesBackend("/Shared/folder"), "workspace");
    assert.equal(isWorkspaceFilesPath("/Workspace"), true);
  });

  it("routes volumes and dbfs", () => {
    assert.equal(resolveDatabricksFilesBackend("/Volumes/main/default/v"), "volumes");
    assert.equal(isVolumesPath("/Volumes/main/default/v/file.txt"), true);
    assert.equal(resolveDatabricksFilesBackend("/dbfs/tmp"), "dbfs");
    assert.equal(isDbfsPath("/dbfs"), true);
  });
});
