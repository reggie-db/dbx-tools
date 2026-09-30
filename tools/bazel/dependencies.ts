import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { root } from "./workspace.ts";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT ?? "120" },
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write((result.stdout ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  process.stderr.write((result.stderr ?? "").replace(/\p{Extended_Pictographic}/gu, ""));
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
  }
}

run(process.execPath, [
  "x",
  "--bun",
  "pnpm@10.32.1",
  "install",
  "--lockfile-only",
  "--ignore-scripts",
  "--config.verify-store-integrity=true",
]);
run("uv", [
  "export",
  "--quiet",
  "--format",
  "requirements-txt",
  "--no-emit-workspace",
  "--output-file",
  "tools/bazel/requirements.txt",
]);
const uvBootstrap = join(root, "tools/bazel/.uv-bootstrap");
rmSync(uvBootstrap, { force: true, recursive: true });
run("uv", [
  "pip",
  "install",
  "--quiet",
  "--requirement",
  "tools/bazel/requirements.txt",
  "--target",
  uvBootstrap,
  "--python",
  "3.12",
]);
run("cargo", ["fetch", "--locked"]);
