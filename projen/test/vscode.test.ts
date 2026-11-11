import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { DBXToolsNodeProject } from "../src/project-js.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function project(outdir: string): DBXToolsNodeProject {
  process.env.PROJEN_DISABLE_POST = "1";
  return new DBXToolsNodeProject({
    name: "vscode-fixture",
    outdir,
    defaultTagMixins: false,
  });
}

describe("VS Code settings", () => {
  it("starts focused sync watch when the folder opens", () => {
    const outdir = mkdtempSync(join(tmpdir(), "dbx-tools-vscode-"));
    temporaryDirectories.push(outdir);
    project(outdir).synth();

    const tasks = JSON.parse(readFileSync(join(outdir, ".vscode/tasks.json"), "utf8")) as {
      tasks: Array<{
        label: string;
        command: string;
        isBackground?: boolean;
        runOptions?: { runOn?: string };
      }>;
    };
    assert.deepEqual(
      tasks.tasks.find(({ label }) => label === "sync"),
      {
        label: "sync",
        detail: "focused sync watch - update generated sources and resynthesize when required",
        type: "shell",
        command: "bun run sync -- --watch",
        isBackground: true,
        problemMatcher: [],
        runOptions: { runOn: "folderOpen" },
        presentation: {
          reveal: "always",
          panel: "dedicated",
          group: "projen",
        },
      },
    );
  });

  it("emits writable settings", () => {
    const outdir = mkdtempSync(join(tmpdir(), "dbx-tools-vscode-"));
    temporaryDirectories.push(outdir);
    const root = project(outdir);

    assert.equal(root.vscode?.settings.file.readonly, false);
    root.synth();

    if (process.platform !== "win32") {
      assert.notEqual(statSync(join(outdir, ".vscode/settings.json")).mode & 0o200, 0);
    }
  });

  it("applies existing JSON-with-comments values as native Projen overrides", () => {
    const outdir = mkdtempSync(join(tmpdir(), "dbx-tools-vscode-"));
    temporaryDirectories.push(outdir);
    project(outdir).synth();

    const settingsPath = join(outdir, ".vscode/settings.json");
    writeFileSync(
      settingsPath,
      `{
  // Local settings remain authoritative across synthesis.
  "editor.formatOnSave": false,
  "files.trimTrailingWhitespace": true,
}
`,
    );

    project(outdir).synth();

    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(settings["editor.formatOnSave"], false);
    assert.equal(settings["files.trimTrailingWhitespace"], true);
    assert.equal(settings["typescript.tsdk"], "node_modules/typescript/lib");
  });

  it("fails before replacing invalid existing settings", () => {
    const outdir = mkdtempSync(join(tmpdir(), "dbx-tools-vscode-"));
    temporaryDirectories.push(outdir);
    project(outdir).synth();

    const settingsPath = join(outdir, ".vscode/settings.json");
    const invalid = '{ "editor.formatOnSave": }\n';
    writeFileSync(settingsPath, invalid);

    assert.throws(() => project(outdir).synth(), /Cannot preserve VS Code settings/);
    assert.equal(readFileSync(settingsPath, "utf8"), invalid);
  });
});
