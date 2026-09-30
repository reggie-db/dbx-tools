import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { parse } from "smol-toml";
import { generateBarrels } from "./barrels.ts";
import { recordedPackages, root } from "./workspace.ts";

const program = new Command()
  .argument("<crate>", "Rust crate directory, such as core, google, or model")
  .option("--check", "check generated source without modifying the checkout")
  .parse();
const crate = program.args[0]!;
if (!/^[a-z][a-z0-9-]*$/.test(crate)) throw new Error("Expected a crate directory name");
const label = `//packages/rs/${crate}:bindings`;
function bazel(args: string[], capture = false): string {
  const result = spawnSync(process.execPath, [join(root, "tools/bazel/bazel.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Bazel failed: ${result.error?.message ?? result.status}`);
  return result.stdout?.trim() ?? "";
}
bazel(["build", label]);
const output = join(root, bazel(["cquery", label, "--output=files"], true));
const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
const nodePackage = recordedPackages().find((pkg) => pkg.name === manifest.node);
if (!nodePackage) throw new Error(`No workspace package named ${manifest.node}`);
const destinations = [
  { source: join(output, "node"), destination: join(nodePackage.dir, "src"), check: true },
];
if (manifest.python) {
  const pythonRoot = join(root, "packages/py");
  const directory = readdirSync(pythonRoot).find((name) => {
    const file = join(pythonRoot, name, "pyproject.toml");
    if (!existsSync(file)) return false;
    const metadata = parse(readFileSync(file, "utf8"));
    return (metadata.tool as any)?.uv?.["build-backend"]?.["module-name"] === manifest.python;
  });
  if (!directory) throw new Error(`No Python package for ${manifest.python}`);
  destinations.push({
    source: join(output, "python"),
    destination: join(pythonRoot, directory, "src", ...manifest.python.split(".")),
    check: false,
  });
}
const stale: string[] = [];
for (const { source, destination, check } of destinations) {
  if (program.opts().check && !check) continue;
  for (const file of readdirSync(source)) {
    const target = join(destination, file);
    const generated = readFileSync(join(source, file));
    if (existsSync(target) && generated.equals(readFileSync(target))) continue;
    if (program.opts().check) {
      stale.push(target);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) chmodSync(target, 0o644);
    copyFileSync(join(source, file), target);
    chmodSync(target, 0o444);
  }
  if (!program.opts().check) {
    for (const file of readdirSync(join(output, "native"))) {
      const target = join(destination, file);
      if (existsSync(target)) chmodSync(target, 0o644);
      copyFileSync(join(output, "native", file), target);
      chmodSync(target, 0o444);
    }
  }
}
if (stale.length) throw new Error(`Stale generated bindings:\n${stale.join("\n")}`);
generateBarrels({ dirs: [nodePackage.dir], check: program.opts().check });
console.log(`Bindings ${program.opts().check ? "checked" : "updated"}: ${crate}`);
