/**
 * Parity tests: the same ignore patterns must make {@link findFiles} and
 * {@link watchFiles} keep the same set of files. Both run against a temp copy of
 * the fixture tree (see the note below the imports for why a temp root is used)
 * and their results are asserted equal, then checked against a concrete list.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep, isAbsolute } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findFiles } from "../src/find";
import { watchFiles } from "../src/watch";

const FIXTURE_SOURCE = fileURLToPath(new URL("fixtures/sample-tree", import.meta.url));

// glob matches ignore patterns against cwd-relative paths, while chokidar
// matches them against absolute paths. The real fixture lives under a `test/`
// directory, so the default `**/test/**` group would match in watch (absolute)
// but not in scan (relative) - a mismatch unrelated to the shared patterns.
// Copying the tree to a neutral temp root removes that ancestor so the two are
// compared purely on pattern parity.
let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "file-scan-parity-"));
  cpSync(FIXTURE_SOURCE, root, { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const toPosix = (path: string): string => path.split(sep).join("/");

/** Files fileScan keeps for the fixture (relative, posix) given `ignore`. */
function scannedFiles(ignore: string | string[] | undefined): Set<string> {
  return new Set([...findFiles("**", { cwd: root, nodir: true, ignore })].map(toPosix));
}

/** Files fileWatch reports for the (static) fixture (relative, posix), then closes. */
async function watchedFiles(ignore: string | string[] | undefined): Promise<Set<string>> {
  const files = new Set<string>();
  const watcher = watchFiles(root, {
    cwd: root,
    ignore,
    persistent: false,
    ignoreInitial: false,
  });
  watcher.on("add", (path) => {
    const rel = isAbsolute(path) ? relative(root, path) : path;
    files.add(toPosix(rel === "" ? "." : rel));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once("ready", () => resolve());
      watcher.once("error", reject);
    });
  } finally {
    await watcher.close();
  }
  return files;
}

/**
 * The same ignore patterns must make fileScan and fileWatch keep the same files.
 * Asserts parity, then returns the (shared) sorted result for concrete checks.
 */
async function keptByBoth(patterns: string | string[] | undefined): Promise<string[]> {
  const scanned = [...scannedFiles(patterns)].sort();
  const watched = [...(await watchedFiles(patterns))].sort();
  assert.deepEqual(watched, scanned);
  return scanned;
}

describe("scan/watch matching parity", () => {
  // `.hidden` (dot group) and any node_modules/dist (default groups) are dropped
  // by both; only the plain source files survive the default ignore list.
  it("keeps the same files with only the default ignore groups", async () => {
    assert.deepEqual(await keptByBoth(undefined), [
      "example/skip.ts",
      "src/index.ts",
      "src/keep.ts",
    ]);
  });

  it("keeps the same files ignoring a file pattern", async () => {
    assert.deepEqual(await keptByBoth("**/index.ts"), ["example/skip.ts", "src/keep.ts"]);
  });

  it("keeps the same files ignoring a directory pattern", async () => {
    assert.deepEqual(await keptByBoth(["**/example/**"]), ["src/index.ts", "src/keep.ts"]);
  });

  it("keeps the same files ignoring multiple patterns", async () => {
    assert.deepEqual(await keptByBoth(["**/index.ts", "**/example/**"]), ["src/keep.ts"]);
  });
});
