import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DBXToolsNodeProject, DBXToolsTypeScriptProject } from "../src/project.ts";

let temp: string;

interface ProjenTsconfig {
  readonly extends?: string | string[];
  readonly include?: string[];
}

function readProjenTsconfig(path: string): ProjenTsconfig {
  const source = readFileSync(path, "utf8").replace(/^\/\/[^\n]*\n/, "");
  return JSON.parse(source) as ProjenTsconfig;
}

before(() => {
  process.env.PROJEN_DISABLE_POST = "1";
  temp = mkdtempSync(join(tmpdir(), "dbx-tools-external-"));
});

after(() => {
  delete process.env.PROJEN_DISABLE_POST;
  rmSync(temp, { recursive: true, force: true });
});

describe("external project roots", () => {
  it(
    "uses an explicit outdir for identity, repository metadata, and discovery",
    {
      timeout: 15_000,
    },
    () => {
      const outdir = join(temp, "consumer");
      mkdirSync(join(outdir, "modules/widget/src"), { recursive: true });
      writeFileSync(join(outdir, "modules/widget/src/widget.ts"), "export const widget = true;\n");
      execFileSync("git", ["init"], { cwd: outdir, stdio: "ignore" });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/example-org/consumer-repo.git"],
        { cwd: outdir, stdio: "ignore" },
      );

      const project = new DBXToolsNodeProject({
        outdir,
        packageRoots: ["modules"],
        defaultTagMixins: false,
        releaseMode: "disabled",
      });
      project.synth();

      const root = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
        name: string;
        repository?: { url?: string };
        workspaces?: string[];
      };
      const child = JSON.parse(
        readFileSync(join(outdir, "modules/widget/package.json"), "utf8"),
      ) as {
        name: string;
        repository?: { url?: string; directory?: string };
      };
      assert.equal(root.name, "consumer-repo");
      assert.equal(root.repository?.url, "git+https://github.com/example-org/consumer-repo.git");
      assert.deepEqual(root.workspaces, ["modules/widget"]);
      assert.equal(child.name, "@consumer-repo/widget");
      assert.equal(child.repository?.url, root.repository?.url);
      assert.equal(child.repository?.directory, "modules/widget");
      const projenTsconfig = readProjenTsconfig(join(outdir, "tsconfig.projen.json"));
      assert.deepEqual([projenTsconfig.extends].flat(), ["./tsconfig.json"]);
      assert.deepEqual(projenTsconfig.include, [".projenrc.ts", "projenrc/**/*.ts"]);
    },
  );

  it("supports a standalone compiling TypeScript workspace root", { timeout: 15_000 }, () => {
    const outdir = join(temp, "standalone");
    mkdirSync(join(outdir, "src"), { recursive: true });
    writeFileSync(join(outdir, "src/main.ts"), "export const ready = true;\n");

    const project = new DBXToolsTypeScriptProject({
      name: "standalone",
      outdir,
      defaultTagMixins: false,
      github: true,
      releaseMode: "disabled",
      tsconfig: { fileName: "tsconfig.build.json" },
    });
    project.synth();

    const tsconfig = readFileSync(join(outdir, "tsconfig.build.json"), "utf8");
    const manifest = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8")) as {
      workspaces?: string[];
    };
    const tasks = JSON.parse(readFileSync(join(outdir, ".projen/tasks.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    assert.match(tsconfig, /src\/\*\*\/\*\.ts/);
    assert.equal(existsSync(join(outdir, "test/.projenrc.ts")), false);
    assert.match(readFileSync(join(outdir, ".eslintrc.json"), "utf8"), /tsconfig\.build\.json/);
    assert.deepEqual(manifest.workspaces, []);
    assert.equal(existsSync(join(outdir, "pnpm-workspace.yaml")), true);
    assert.equal(tasks.tasks.release, undefined);
    assert.equal(tasks.tasks.bump, undefined);
    assert.equal(tasks.tasks["version:check"], undefined);
    assert.equal(existsSync(join(outdir, ".github/workflows/release.yml")), false);
    const projenTsconfig = readProjenTsconfig(join(outdir, "tsconfig.projen.json"));
    assert.deepEqual([projenTsconfig.extends].flat(), ["./tsconfig.build.json"]);
    assert.deepEqual(projenTsconfig.include, [".projenrc.ts", "projenrc/**/*.ts"]);
  });
});
