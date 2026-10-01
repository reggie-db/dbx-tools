#!/usr/bin/env -S bun
/** Bundle the owning Rust release helper source into a standalone Node module. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as exec from "@dbx-tools/core/exec";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "dbx-rust-release-bundle-"));
try {
  const bundled = join(temporary, "rust-release.mjs");
  const declarations = join(temporary, "declarations");
  exec.spawnSync(
    process.execPath,
    [
      "build",
      resolve(root, "src/_rust-release.ts"),
      "--target=node",
      "--format=esm",
      `--outfile=${bundled}`,
    ],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    },
  );
  const output = resolve(root, "tasks/rust-release.mjs");
  const source = readFileSync(bundled, "utf8");
  writeFileSync(
    output,
    `#!/usr/bin/env node\n// GENERATED from src/_rust-release.ts by tasks/build-rust-release.ts.\n${source.replace(/^#![^\n]*\n/, "")}`,
  );
  chmodSync(output, 0o755);
  exec.spawnSync(
    "bunx",
    [
      "tsc",
      resolve(root, "src/_rust-release.ts"),
      "--declaration",
      "--emitDeclarationOnly",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "--outDir",
      declarations,
    ],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      check: true,
    },
  );
  writeFileSync(
    resolve(root, "tasks/rust-release.d.ts"),
    readFileSync(join(declarations, "_rust-release.d.ts")),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
