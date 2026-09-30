import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const pins = JSON.parse(readFileSync(join(root, "tools/build/tools.lock.json"), "utf8"));

export async function nativeTool(name: "buck2" | "reindeer") {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const platform = process.platform === "darwin" ? "apple-darwin" : process.platform === "linux" ? "unknown-linux-gnu" : "pc-windows-msvc.exe";
  const asset = pins.tools[name].assets[`${name}-${arch}-${platform}.zst`];
  if (!asset) throw new Error(`No pinned ${name} for ${process.platform}/${process.arch}`);
  const executable = join(root, ".buck2/bin", pins.tools[name].tag, name);
  if (existsSync(executable)) return executable;
  mkdirSync(dirname(executable), { recursive: true });
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== asset.sha256) throw new Error(`${name} checksum mismatch`);
  const unpacked = spawnSync("zstd", ["-d", "-c"], { input: archive, maxBuffer: 400 * 1024 * 1024 });
  if (unpacked.status !== 0) throw new Error("Install zstd to unpack the pinned tools");
  writeFileSync(`${executable}.tmp`, unpacked.stdout);
  chmodSync(`${executable}.tmp`, 0o755);
  renameSync(`${executable}.tmp`, executable);
  return executable;
}

export function prepareHostTools() {
  const directory = join(root, ".buck2/host-tools");
  mkdirSync(directory, { recursive: true });
  for (const name of ["bun", "uv"] as const) {
    const executable = Bun.which(name);
    if (!executable) throw new Error(`Install ${name} ${pins[name]}`);
    const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
    if (!result.stdout.trim().split(/\s+/).includes(pins[name])) throw new Error(`Expected ${name} ${pins[name]}, got ${result.stdout.trim()}`);
    const target = join(directory, name);
    if (!existsSync(target) || !readFileSync(target).equals(readFileSync(executable))) {
      copyFileSync(executable, target);
      chmodSync(target, 0o755);
    }
  }
  const config = '[cells]\n  host_tools = .\n  root = ../..\n  prelude = ../../prelude\n  toolchains = ../../toolchains\n';
  const build = 'load("@root//rules:tools.bzl", "executable")\n\nexecutable(name = "bun", binary = "bun", visibility = ["PUBLIC"])\nexecutable(name = "uv", binary = "uv", visibility = ["PUBLIC"])\n';
  for (const [file, content] of [[".buckconfig", config], ["BUCK", build]]) {
    if (!existsSync(join(directory, file)) || readFileSync(join(directory, file), "utf8") !== content) writeFileSync(join(directory, file), content);
  }
}
