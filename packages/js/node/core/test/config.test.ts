import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { context } from "@dbx-tools/shared-core";

import { config } from "../index.ts";

afterEach(() => context.clear());

async function fixture(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dbx-tools-config-")));
  await writeFile(join(dir, "package.json"), '{"name":"fixture"}\n');
  return dir;
}

describe("config", () => {
  it("resolves scope and prefix names before the bare key", () => {
    process.env.DBX_TOOLS_TUNNEL_AUTH_SUBJECT = "scoped";
    process.env.TUNNEL_AUTH_SUBJECT = "prefixed";
    process.env.AUTH_SUBJECT = "bare";
    try {
      assert.equal(config.text("AUTH_SUBJECT", { scope: "DBX_TOOLS", prefix: "TUNNEL" }), "scoped");
      delete process.env.DBX_TOOLS_TUNNEL_AUTH_SUBJECT;
      assert.equal(
        config.text("AUTH_SUBJECT", { scope: "DBX_TOOLS", prefix: "TUNNEL" }),
        "prefixed",
      );
      delete process.env.TUNNEL_AUTH_SUBJECT;
      assert.equal(config.text("AUTH_SUBJECT", { scope: "DBX_TOOLS", prefix: "TUNNEL" }), "bare");
    } finally {
      delete process.env.DBX_TOOLS_TUNNEL_AUTH_SUBJECT;
      delete process.env.TUNNEL_AUTH_SUBJECT;
      delete process.env.AUTH_SUBJECT;
    }
  });

  it("prefers the environment over a .env file", async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, ".env"), "DBX_TOOLS_SAMPLE=from-dotenv\n");
      process.env.DBX_TOOLS_SAMPLE = "from-env";
      assert.equal(config.text("SAMPLE", { cwd: dir, sources: ["env", "dotenv"] }), "from-env");
    } finally {
      delete process.env.DBX_TOOLS_SAMPLE;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the .env file, unscoped key included", async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, ".env"), "export QUOTED='  kept  '\nPLAIN=value # trailing\n");
      assert.equal(config.text("QUOTED", { cwd: dir, sources: "dotenv" }), "kept");
      assert.equal(config.text("PLAIN", { cwd: dir, sources: "dotenv" }), "value");
      assert.equal(config.text("MISSING", { cwd: dir, sources: "dotenv" }), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("searches from cwd upward through the project root", async () => {
    const root = await fixture();
    const parent = join(root, "packages");
    const cwd = join(parent, "app");
    try {
      await mkdir(cwd, { recursive: true });
      await writeFile(join(root, ".env"), "SAMPLE=from-root\n");
      await writeFile(join(parent, ".env"), "SAMPLE=from-parent\n");
      assert.equal(config.text("SAMPLE", { cwd, sources: "dotenv" }), "from-parent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not traverse upward without a project root", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "dbx-tools-no-root-")));
    const cwd = join(parent, "nested");
    try {
      await mkdir(cwd);
      await writeFile(join(parent, ".env"), "SAMPLE=from-parent\n");
      assert.equal(config.text("SAMPLE", { cwd, sources: "dotenv" }), undefined);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("prefers the exact environment file, then its alias, then .env", async () => {
    const dir = await fixture();
    const original = process.env.NODE_ENV;
    try {
      await writeFile(join(dir, ".env"), "SAMPLE=from-default\n");
      await writeFile(join(dir, ".env.production"), "SAMPLE=from-production\n");
      await writeFile(join(dir, ".env.prod"), "SAMPLE=from-prod\n");

      process.env.NODE_ENV = "production";
      assert.equal(config.text("SAMPLE", { cwd: dir, sources: "dotenv" }), "from-production");

      process.env.NODE_ENV = "prod";
      assert.equal(config.text("SAMPLE", { cwd: dir, sources: "dotenv" }), "from-prod");
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("config.isDatabricksAppEnv", () => {
  const valid = {
    DATABRICKS_APP_NAME: "demo",
    DATABRICKS_HOST: "https://workspace.example.com",
    DATABRICKS_APP_PORT: "8000",
  };

  it("recognizes a complete Databricks App environment", () => {
    assert.equal(config.isDatabricksAppEnv(valid), true);
  });

  it("rejects invalid hosts, ports, and incomplete environments", () => {
    assert.equal(config.isDatabricksAppEnv({ ...valid, DATABRICKS_HOST: "file:///tmp" }), false);
    assert.equal(config.isDatabricksAppEnv({ ...valid, DATABRICKS_APP_PORT: "0" }), false);
    assert.equal(config.isDatabricksAppEnv({ ...valid, DATABRICKS_APP_NAME: "" }), false);
  });
});
