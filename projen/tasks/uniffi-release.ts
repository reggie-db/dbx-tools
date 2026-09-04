#!/usr/bin/env -S bun
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const parsed = parseArgs({
  allowPositionals: true,
  options: {
    crate: { type: "string" },
    rust: { type: "string" },
    node: { type: "string" },
    python: { type: "string" },
    "node-package": { type: "string" },
    "python-package": { type: "string" },
    "cargo-target": { type: "string" },
    "node-triple": { type: "string" },
    "python-tag": { type: "string" },
    os: { type: "string" },
    cpu: { type: "string" },
    libc: { type: "string" },
    facade: { type: "string" },
    version: { type: "string" },
  },
});

const required = (name: keyof typeof parsed.values): string => {
  const value = parsed.values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};

const run = (command: string, args: string[], cwd = root): void => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};

const replaceVersion = (source: string, version: string): string =>
  source.replace(/^version = "[^"]+"$/m, `version = "${version}"`);

function build(): void {
  const crate = required("crate");
  required("rust");
  const cargoTarget = required("cargo-target");
  const nodeTriple = required("node-triple");
  const pythonTag = required("python-tag");
  const version = required("version");
  const os = required("os");
  const cpu = required("cpu");
  const nodeDirectory = parsed.values.node;
  const pythonDirectory = parsed.values.python;
  const nodePackage = parsed.values["node-package"];
  const pythonPackage = parsed.values["python-package"];
  const libraryName = crate.replaceAll("-", "_");
  const extension = os === "darwin" ? "dylib" : os === "win32" ? "dll" : "so";
  const prefix = os === "win32" ? "" : "lib";
  const libraryFile = `${prefix}${libraryName}.${extension}`;
  const library = resolve(root, "target", cargoTarget, "release", libraryFile);
  const output = resolve(root, "dist/uniffi");

  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, "npm"), { recursive: true });
  mkdirSync(join(output, "npm-facade"), { recursive: true });
  mkdirSync(join(output, "python"), { recursive: true });
  run("cargo", ["build", "--release", "--package", crate, "--target", cargoTarget]);
  if (!existsSync(library)) throw new Error(`Missing native library ${library}`);

  if (nodeDirectory && nodePackage) {
    const nativePackage = resolve(output, "native-node");
    mkdirSync(nativePackage, { recursive: true });
    cpSync(library, join(nativePackage, libraryFile));
    writeFileSync(
      join(nativePackage, "package.json"),
      `${JSON.stringify(
        {
          name: `${nodePackage}-${nodeTriple}`,
          version,
          description: `Native ${nodeTriple} library for ${nodePackage}`,
          license: "Apache-2.0",
          os: [os],
          cpu: [cpu],
          ...(parsed.values.libc ? { libc: [parsed.values.libc] } : {}),
          files: [libraryFile],
        },
        null,
        2,
      )}\n`,
    );
    run("npm", ["pack", "--pack-destination", resolve(output, "npm")], nativePackage);

    if (parsed.values.facade === "true") {
      const facade = resolve(output, "facade-node");
      cpSync(resolve(root, nodeDirectory), facade, { recursive: true });
      rmSync(join(facade, "src", libraryFile), { force: true });
      const manifestPath = join(facade, "package.json");
      const manifestMode = statSync(manifestPath).mode;
      chmodSync(manifestPath, manifestMode | 0o200);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.version = version;
      manifest.private = false;
      manifest.license = manifest.license === "UNLICENSED" ? "Apache-2.0" : manifest.license;
      manifest.optionalDependencies = Object.fromEntries(
        Object.keys(manifest.optionalDependencies ?? {}).map((name) => [name, version]),
      );
      manifest.dependencies = Object.fromEntries(
        Object.entries(manifest.dependencies ?? {}).map(([name, dependency]) => [
          name,
          typeof dependency === "string" && dependency.startsWith("workspace:")
            ? version
            : dependency,
        ]),
      );
      delete manifest.scripts;
      delete manifest.devDependencies;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const generator = resolve(root, "node_modules/@dbx-tools/projen/tasks/uniffi.ts");
      run("bun", [
        generator,
        "--crate",
        crate,
        "--node",
        facade,
        "--cargo-target",
        cargoTarget,
        "--node-package-base",
        `${nodePackage}-`,
      ]);
      run("npm", ["pack", "--pack-destination", resolve(output, "npm-facade")], facade);
    }
  }

  if (pythonDirectory && pythonPackage) {
    const pythonRoot = resolve(output, "python-root");
    cpSync(resolve(root, pythonDirectory), pythonRoot, { recursive: true });
    const pyproject = join(pythonRoot, "pyproject.toml");
    const mode = statSync(pyproject).mode;
    chmodSync(pyproject, mode | 0o200);
    writeFileSync(pyproject, replaceVersion(readFileSync(pyproject, "utf8"), version));
    const generator = resolve(root, "node_modules/@dbx-tools/projen/tasks/uniffi.ts");
    run("bun", [
      generator,
      "--crate",
      crate,
      "--python",
      pythonRoot,
      "--cargo-target",
      cargoTarget,
    ]);
    run("uv", ["build", "--wheel", "--out-dir", resolve(output, "python")], pythonRoot);
    const wheels = [...new Bun.Glob("*.whl").scanSync(join(output, "python"))];
    if (wheels.length !== 1) throw new Error(`Expected one Python wheel, found ${wheels.length}`);
    run("uvx", ["--from", "wheel", "wheel", "tags", "--remove", "--platform-tag", pythonTag, join(output, "python", wheels[0]!)]);
  }
}

if (parsed.positionals[0] !== "build") throw new Error("Expected build command");
build();
