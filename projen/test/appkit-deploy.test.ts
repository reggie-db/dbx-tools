import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { deployApp } from "../tasks/appkit-deploy.ts";

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  readonly root: string;
  readonly rootManifest: string;
  readonly childManifest: string;
} {
  const root = mkdtempSync(join(tmpdir(), "appkit-deploy-"));
  fixtures.push(root);
  const childDirectory = join(root, "packages/app");
  mkdirSync(childDirectory, { recursive: true });
  const rootManifest = `${JSON.stringify(
    {
      name: "fixture",
      version: "1.2.3",
      workspaces: ["packages/app"],
      catalog: { react: "19.2.7" },
      devDependencies: { react: "catalog:" },
    },
    null,
    2,
  )}\n`;
  const childManifest = `${JSON.stringify(
    {
      name: "@fixture/app",
      version: "1.2.3",
      dependencies: {
        "@fixture/shared": "workspace:^",
        react: "catalog:",
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(root, "package.json"), rootManifest);
  writeFileSync(join(childDirectory, "package.json"), childManifest);
  chmodSync(join(root, "package.json"), 0o444);
  chmodSync(join(childDirectory, "package.json"), 0o444);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  return { root, rootManifest, childManifest };
}

it("materializes manifests only while Databricks deploy runs", async () => {
  const { root, rootManifest, childManifest } = fixture();
  const args = ["--target", "dev", "--profile", "TEST"];
  let called = false;
  let stage = "";

  await deployApp(args, {
    root,
    run: async (actualArgs, cwd) => {
      called = true;
      stage = cwd;
      assert.deepEqual(actualArgs, ["--skip-validation", ...args]);
      assert.notEqual(cwd, root);
      assert.equal(readFileSync(join(root, "package.json"), "utf8"), rootManifest);
      const materializedRoot = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        devDependencies: Record<string, string>;
      };
      const materializedChild = JSON.parse(
        readFileSync(join(cwd, "packages/app/package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      assert.equal(materializedRoot.devDependencies.react, "19.2.7");
      assert.equal(materializedChild.dependencies["@fixture/shared"], "^1.2.3");
      assert.equal(materializedChild.dependencies.react, "19.2.7");
      return { exitCode: 0 };
    },
  });

  assert.equal(called, true);
  assert.equal(existsSync(stage), false);
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), rootManifest);
  assert.equal(readFileSync(join(root, "packages/app/package.json"), "utf8"), childManifest);
  assert.equal(statSync(join(root, "package.json")).mode & 0o777, 0o444);
  assert.equal(statSync(join(root, "packages/app/package.json")).mode & 0o777, 0o444);
});

it("restores manifests when Databricks deploy fails", async () => {
  const { root, rootManifest, childManifest } = fixture();
  let stage = "";

  await assert.rejects(
    deployApp([], {
      root,
      resolveProfile: () => "TEST",
      run: async (actualArgs, cwd) => {
        assert.deepEqual(actualArgs, ["--skip-validation", "--profile", "TEST"]);
        stage = cwd;
        return { exitCode: 1 };
      },
    }),
    /databricks apps deploy exited with code 1/,
  );

  assert.equal(readFileSync(join(root, "package.json"), "utf8"), rootManifest);
  assert.equal(readFileSync(join(root, "packages/app/package.json"), "utf8"), childManifest);
  assert.equal(existsSync(stage), false);
});

it("preserves an explicit skip-validation flag without duplicating it", async () => {
  const { root } = fixture();
  await deployApp(["--skip-validation", "--target", "dev", "--profile", "TEST"], {
    root,
    run: async (args) => {
      assert.deepEqual(args, ["--skip-validation", "--target", "dev", "--profile", "TEST"]);
      return { exitCode: 0 };
    },
  });
});

it("fails before staging when no explicit authentication resolves", async () => {
  const { root } = fixture();
  await assert.rejects(
    deployApp(["--target", "dev"], {
      environment: {},
      root,
      resolveProfile: () => undefined,
      run: async () => {
        throw new Error("deploy must not run");
      },
    }),
    /Select a Databricks profile/,
  );
});
