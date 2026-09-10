#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function command(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result.stdout;
}

const hasLock = existsSync("Cargo.lock");
const metadata = JSON.parse(
  command("cargo", [
    "metadata",
    ...(hasLock ? ["--locked"] : []),
    "--format-version",
    "1",
    "--no-deps",
  ]),
);
const workspaceNames = new Set(metadata.packages.map((pkg) => pkg.name));
const dependencyLock = hasLock
  ? readFileSync("Cargo.lock", "utf8")
      .split("[[package]]")
      .slice(1)
      .filter((block) => {
        const name = /^\s*name = "([^"]+)"/m.exec(block)?.[1];
        return name && !workspaceNames.has(name);
      })
      .map((block) => `[[package]]${block}`)
      .join("")
  : "";
const manifests = [
  metadata.workspace_root + "/Cargo.toml",
  ...metadata.packages.map((pkg) => pkg.manifest_path),
]
  .map((path) =>
    readFileSync(path, "utf8").replace(/^version = "[0-9]+\.[0-9]+\.[0-9]+"\s*$/gm, ""),
  )
  .join("\n");
const config = existsSync(".cargo/config.toml")
  ? readFileSync(".cargo/config.toml", "utf8")
  : "";
const key = createHash("sha256")
  .update(dependencyLock)
  .update(manifests)
  .update(config)
  .update(command("rustc", ["-vV"]))
  .digest("hex");
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
} else {
  process.stdout.write(`${key}\n`);
}