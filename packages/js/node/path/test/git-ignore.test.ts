import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { findFiles, findFilesSync } from "../src/find.ts";
import { GitIgnore } from "../src/git-ignore.ts";
import { watchFiles } from "../src/watch.ts";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dbx-git-ignore-"));
  roots.push(root);
  return root;
}

async function waitFor(check: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for file event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitIgnore", () => {
  it("updates root and nested Git-compatible rules in memory", async () => {
    const root = await fixture();
    const matcher = new GitIgnore(root);
    const ignoredSourcePath = matcher.matcher.and((path) => path.startsWith("src/"));
    matcher.set(".gitignore", "*.tmp\nbuild/\n");
    matcher.set("src/example/.gitignore", "!keep.tmp\n");

    assert.equal(matcher.ignores("drop.tmp"), true);
    assert.equal(matcher.ignores("src/example/drop.tmp"), true);
    assert.equal(ignoredSourcePath("src/example/drop.tmp"), true);
    assert.equal(ignoredSourcePath("drop.tmp"), false);
    assert.equal(matcher.ignores("src/example/keep.tmp"), false);
    assert.equal(matcher.ignores("build/output.js"), true);
    assert.equal(matcher.get(".gitignore"), "*.tmp\nbuild/\n");

    matcher.set("src/example/.gitignore", "*.ts\n");
    assert.equal(matcher.ignores("src/example/keep.tmp"), true);
    assert.equal(matcher.ignores("src/example/file.ts"), true);

    assert.equal(matcher.delete("src/example/.gitignore"), true);
    assert.equal(matcher.ignores("src/example/file.ts"), false);
  });

  it("does not let nested rules reinclude files beneath an ignored parent", async () => {
    const root = await fixture();
    const matcher = new GitIgnore(root);
    matcher.set(".gitignore", "src/example/\n");
    matcher.set("src/example/.gitignore", "!keep.ts\n");

    assert.equal(matcher.ignores("src/example/keep.ts"), true);
  });

  it("loads nested rules for asynchronous and synchronous scans", async () => {
    const root = await fixture();
    await mkdir(join(root, "src/example"), { recursive: true });
    await mkdir(join(root, "src/generated"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "*.secret\nsrc/generated/\n");
    await writeFile(join(root, "src/example/.gitignore"), "*.tmp\n!keep.tmp\n");
    await writeFile(join(root, "keep.ts"), "");
    await writeFile(join(root, "ignored.secret"), "");
    await writeFile(join(root, "src/generated/code.ts"), "");
    await writeFile(join(root, "src/example/drop.tmp"), "");
    await writeFile(join(root, "src/example/keep.tmp"), "");

    const options = {
      cwd: root,
      nodir: true,
      ignoreOptions: { git: true, lock: false as const, test: false },
    };
    const asynchronous: string[] = [];
    for await (const path of findFiles("**/*", options)) asynchronous.push(path);
    const synchronous = [...findFilesSync("**/*", options)];

    assert.deepEqual(asynchronous.sort(), ["keep.ts", "src/example/keep.tmp"]);
    assert.deepEqual(synchronous.sort(), asynchronous);
  });

  it("updates watcher rules when .gitignore is added and removed", async () => {
    const root = await fixture();
    const added = new Set<string>();
    const watcher = await watchFiles(root, {
      cwd: root,
      ignoreInitial: true,
      ignoreOptions: { git: true, lock: false, test: false },
    });
    watcher.on("add", (path) => added.add(basename(path)));
    try {
      await once(watcher, "ready");
      await writeFile(join(root, ".gitignore"), "*.secret\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(join(root, "hidden.secret"), "");
      await writeFile(join(root, "visible.ts"), "");
      await waitFor(() => added.has("visible.ts"));
      assert.equal(added.has("hidden.secret"), false);

      await rm(join(root, ".gitignore"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(join(root, "restored.secret"), "");
      await waitFor(() => added.has("restored.secret"));
    } finally {
      await watcher.close();
    }
  });
});
