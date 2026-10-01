#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const hash = createHash("sha256");

function trackedFiles() {
  const output = Bun.spawnSync(
    ["git", "ls-files", "-z", "Cargo.lock", "Cargo.toml", "packages/rs"],
    { cwd: root, stdout: "pipe", stderr: "inherit" },
  );
  if (output.exitCode !== 0) process.exit(output.exitCode);
  return output.stdout
    .toString()
    .split("\0")
    .filter((file) => file.endsWith(".rs") || file.endsWith("Cargo.toml") || file === "Cargo.lock")
    .sort();
}

function normalized(file) {
  const content = fs.readFileSync(path.join(root, file));
  if (file !== "Cargo.toml") return content;
  return Buffer.from(
    content
      .toString("utf8")
      .replace(/(\[workspace\.package\][\s\S]*?\n)\s*version = "[^"]+"\n/, "$1"),
  );
}

for (const file of trackedFiles()) {
  hash.update(file);
  hash.update("\0");
  hash.update(normalized(file));
  hash.update("\0");
}

process.stdout.write(hash.digest("hex"));
