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
const DEPLOY_DEFAULTS = ["--fail-on-active-runs", "--skip-tests", "--skip-validation"] as const;

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
  const sharedDirectory = join(root, "packages/shared");
  mkdirSync(join(root, "client/dist"), { recursive: true });
  writeFileSync(join(root, "client/dist/index.html"), "<html></html>\n");
  mkdirSync(childDirectory, { recursive: true });
  mkdirSync(sharedDirectory, { recursive: true });
  mkdirSync(join(childDirectory, "client/dist"), { recursive: true });
  writeFileSync(join(childDirectory, "client/dist/index.html"), "<html></html>\n");
  const rootManifest = `${JSON.stringify(
    {
      name: "fixture",
      version: "1.2.3",
      workspaces: ["packages/app", "packages/shared"],
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
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - "packages/app"\n  - "packages/shared"\n',
  );
  writeFileSync(join(childDirectory, "package.json"), childManifest);
  writeFileSync(
    join(sharedDirectory, "package.json"),
    `${JSON.stringify({ name: "@fixture/shared", version: "1.2.3" })}\n`,
  );
  writeFileSync(join(sharedDirectory, "index.ts"), "export const shared = true;\n");
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
      assert.deepEqual(actualArgs, [...args, ...DEPLOY_DEFAULTS]);
      assert.notEqual(cwd, root);
      assert.equal(readFileSync(join(root, "package.json"), "utf8"), rootManifest);
      const materializedRoot = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        devDependencies: Record<string, string>;
      };
      const materializedChild = JSON.parse(
        readFileSync(join(cwd, "packages/app/package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      assert.equal(existsSync(join(cwd, "packages/app/client/dist/index.html")), true);
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

it("prints current app logs and restores manifests when deploy fails", async () => {
  const { root, rootManifest, childManifest } = fixture();
  let stage = "";
  let logsRead = false;

  await assert.rejects(
    deployApp(["--target", "dev", "--var", "app_name=test"], {
      environment: {},
      logs: async (args, cwd) => {
        logsRead = true;
        assert.deepEqual(args, ["--target", "dev", "--profile", "TEST", "--var", "app_name=test"]);
        assert.equal(cwd, stage);
        return { exitCode: 0 };
      },
      root,
      resolveProfile: () => "TEST",
      run: async (actualArgs, cwd) => {
        assert.deepEqual(actualArgs, [
          "--target",
          "dev",
          "--profile",
          "TEST",
          "--var",
          "app_name=test",
          ...DEPLOY_DEFAULTS,
        ]);
        stage = cwd;
        return { exitCode: 1 };
      },
    }),
    /databricks apps deploy exited with code 1/,
  );

  assert.equal(readFileSync(join(root, "package.json"), "utf8"), rootManifest);
  assert.equal(readFileSync(join(root, "packages/app/package.json"), "utf8"), childManifest);
  assert.equal(logsRead, true);
  assert.equal(existsSync(stage), false);
});

it("preserves the deploy failure when reading logs also fails", async () => {
  const { root } = fixture();
  await assert.rejects(
    deployApp(["--profile", "TEST"], {
      logs: async () => {
        throw new Error("logs unavailable");
      },
      root,
      run: async () => ({ exitCode: 2 }),
    }),
    /databricks apps deploy exited with code 2/,
  );
});

it("preserves explicit deployment defaults without duplicating them", async () => {
  const { root } = fixture();
  await deployApp([...DEPLOY_DEFAULTS, "--target", "dev", "--profile", "TEST"], {
    root,
    run: async (args) => {
      assert.deepEqual(args, ["--target", "dev", "--profile", "TEST", ...DEPLOY_DEFAULTS]);
      return { exitCode: 0 };
    },
  });
});

it("validates the source bundle with the resolved deployment context", async () => {
  const { root } = fixture();
  let validated = false;
  await deployApp(["--target", "dev"], {
    environment: {},
    resolveProfile: () => "TEST",
    root,
    run: async () => ({ exitCode: 0 }),
    validate: async (args, cwd) => {
      validated = true;
      assert.deepEqual(args, ["--target", "dev", "--profile", "TEST"]);
      assert.equal(cwd, root);
      return { exitCode: 0 };
    },
  });
  assert.equal(validated, true);
});

it("runs validation and deployment from the configured application directory", async () => {
  const { root } = fixture();
  let validated = false;
  await deployApp(["--directory", "packages/app", "--target", "dev", "--profile", "TEST"], {
    root,
    run: async (args, cwd) => {
      assert.deepEqual(args, ["--target", "dev", "--profile", "TEST", ...DEPLOY_DEFAULTS]);
      assert.ok(cwd.endsWith("packages/app"));
      const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      assert.match(manifest.dependencies["@fixture/shared"]!, /^file:\.\/vendor\/npm\/.+\.tgz$/);
      assert.equal(existsSync(join(cwd, "vendor/npm")), true);
      return { exitCode: 0 };
    },
    validate: async (args, cwd) => {
      validated = true;
      assert.deepEqual(args, ["--target", "dev", "--profile", "TEST"]);
      assert.equal(cwd, join(root, "packages/app"));
      return { exitCode: 0 };
    },
  });
  assert.equal(validated, true);
});

it("removes only stale direct-engine state from the staged snapshot", async () => {
  const { root } = fixture();
  const state = join(root, ".databricks/bundle/dev/resources.json");
  mkdirSync(join(root, ".databricks/bundle/dev"), { recursive: true });
  writeFileSync(state, "{}\n");

  await deployApp(["--target", "dev", "--profile", "TEST"], {
    plan: async () => ({
      exitCode: 1,
      stderr: "Lineage mismatch in state files: local state conflicts with remote direct state",
    }),
    root,
    run: async (_args, stage) => {
      assert.equal(existsSync(join(stage, ".databricks/bundle/dev/resources.json")), false);
      return { exitCode: 0 };
    },
  });

  assert.equal(existsSync(state), true);
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
