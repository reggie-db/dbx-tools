import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  clearOsPathsCache,
  resolveLocalHome,
  resolveLocalTemp,
  resolveOsPaths,
} from "../src/os-path.ts";

const APP_ENV = {
  DATABRICKS_APP_NAME: "demo",
  DATABRICKS_HOST: "https://example.cloud.databricks.com",
  DATABRICKS_APP_PORT: "8000",
};

describe("os-path home", () => {
  it("prefers os.homedir before HOME env", async () => {
    const osHome = await mkdtemp(path.join(tmpdir(), "dbx-os-home-first-"));
    const envHome = await mkdtemp(path.join(tmpdir(), "dbx-env-home-second-"));
    try {
      assert.equal(
        resolveLocalHome({
          cwd: path.join(tmpdir(), "unused"),
          env: { HOME: envHome },
          homeDir: () => osHome,
        }),
        osHome,
      );
    } finally {
      await rm(osHome, { recursive: true, force: true });
      await rm(envHome, { recursive: true, force: true });
    }
  });

  it("falls through to HOME when os.homedir create fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-home-env-fallback-"));
    const envHome = path.join(cwd, "env-home");
    try {
      assert.equal(
        resolveLocalHome({
          cwd,
          env: { HOME: envHome },
          homeDir: () => "/dev/null/not-a-home",
        }),
        envHome,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates os.homedir when it does not exist yet", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "dbx-os-home-parent-"));
    const home = path.join(parent, "missing-home");
    try {
      assert.equal(resolveLocalHome({ cwd: parent, homeDir: () => home, env: {} }), home);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("falls through to app home when os home and HOME create fail", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-app-home-cwd-"));
    const appHome = path.join(cwd, "app-home");
    try {
      assert.equal(
        resolveLocalHome({
          cwd,
          env: APP_ENV,
          homeDir: () => "/dev/null/not-a-home",
          appHome,
        }),
        appHome,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates ./.home when earlier candidates fail", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-local-dot-home-"));
    try {
      const home = resolveLocalHome({ cwd, env: {}, homeDir: () => "" });
      assert.equal(home, path.resolve(cwd, ".home"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips a read-only candidate that exists but cannot be written", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-readonly-home-"));
    const readOnly = path.join(cwd, "readonly-home");
    const writable = path.join(cwd, "writable-home");
    await mkdir(readOnly, { recursive: true });
    await chmod(readOnly, 0o555);
    try {
      assert.equal(
        resolveLocalHome({
          cwd,
          env: { HOME: writable },
          homeDir: () => readOnly,
        }),
        writable,
      );
    } finally {
      await chmod(readOnly, 0o755);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("os-path temp", () => {
  it("prefers os.tmpdir before TMP / TEMP", async () => {
    const osTmp = await mkdtemp(path.join(tmpdir(), "dbx-os-tmp-first-"));
    const envTmp = await mkdtemp(path.join(tmpdir(), "dbx-env-tmp-second-"));
    try {
      assert.equal(
        resolveLocalTemp({
          cwd: path.join(tmpdir(), "unused-tmp"),
          env: { TMP: envTmp, TEMP: envTmp },
          homeDir: () => path.join(tmpdir(), "unused-home"),
          tmpDir: () => osTmp,
        }),
        osTmp,
      );
    } finally {
      await rm(osTmp, { recursive: true, force: true });
      await rm(envTmp, { recursive: true, force: true });
    }
  });

  it("falls through TMPDIR then TMP then TEMP", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-tmp-env-order-"));
    const tmpdirEnv = path.join(cwd, "tmpdir");
    const tmp = path.join(cwd, "tmp");
    const temp = path.join(cwd, "temp");
    try {
      assert.equal(
        resolveLocalTemp({
          cwd,
          env: { TMPDIR: tmpdirEnv, TMP: tmp, TEMP: temp },
          homeDir: () => path.join(cwd, "home"),
          tmpDir: () => "/dev/null/not-a-tmp",
        }),
        tmpdirEnv,
      );
      assert.equal(
        resolveLocalTemp({
          cwd,
          env: { TMP: tmp, TEMP: temp },
          homeDir: () => path.join(cwd, "home"),
          tmpDir: () => "/dev/null/not-a-tmp",
        }),
        tmp,
      );
      assert.equal(
        resolveLocalTemp({
          cwd,
          env: { TEMP: temp },
          homeDir: () => path.join(cwd, "home"),
          tmpDir: () => "/dev/null/not-a-tmp",
        }),
        temp,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates <home>/.tmp when temp candidates fail", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-home-dot-tmp-"));
    const home = path.join(cwd, "home");
    const blocker = path.join(cwd, "blocker");
    await writeFile(blocker, "not a directory");
    try {
      const paths = resolveOsPaths({
        cwd,
        env: {},
        homeDir: () => home,
        tmpDir: () => path.join(blocker, "tmp"),
      });
      assert.equal(paths.home, home);
      assert.equal(paths.tmp, path.join(home, ".tmp"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("os-path cache", () => {
  it("memoizes process-cwd resolutions and clearOsPathsCache resets", () => {
    clearOsPathsCache();
    const first = resolveOsPaths();
    const second = resolveOsPaths();
    assert.equal(first, second);
    clearOsPathsCache();
    const third = resolveOsPaths();
    assert.notEqual(first, third);
    assert.equal(third.home, first.home);
    assert.equal(third.tmp, first.tmp);
  });
});
