#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    crate: { type: "string" },
    node: { type: "string" },
    python: { type: "string" },
    "node-package": { type: "string" },
    "node-generator": { type: "string" },
    "python-package": { type: "string" },
    "cargo-target": { type: "string" },
    "node-triple": { type: "string" },
    "python-tag": { type: "string" },
    os: { type: "string" },
    cpu: { type: "string" },
    libc: { type: "string" },
    facade: { type: "string" },
    version: { type: "string" },
    output: { type: "string" },
    "skip-build": { type: "boolean" },
  },
});

const required = (name) => {
  const value = parsed.values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};

const root = resolve(parsed.values.root ?? process.cwd());
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};

const replaceVersion = (source, version) =>
  source.replace(/^version = "[^"]+"$/m, `version = "${version}"`);

const writable = (path) => {
  if (existsSync(path)) chmodSync(path, statSync(path).mode | 0o200);
};

const libraryPath = (crate, cargoTarget, os) => {
  const name = crate.replaceAll("-", "_");
  const extension = os === "darwin" ? "dylib" : os === "win32" ? "dll" : "so";
  const prefix = os === "win32" ? "" : "lib";
  return resolve(root, "target", cargoTarget, "release", `${prefix}${name}.${extension}`);
};

const packageNode = ({
  crate,
  library,
  output,
  nodeDirectory,
  nodePackage,
  nodeTriple,
  os,
  cpu,
  version,
  facade,
    nodeGenerator,
}) => {
  const libraryFile = basename(library);
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
  mkdirSync(resolve(output, "npm"), { recursive: true });
  run("npm", ["pack", "--pack-destination", resolve(output, "npm")], nativePackage);

  if (!facade) return;
  const facadeDirectory = resolve(output, "facade-node");
  cpSync(resolve(root, nodeDirectory), facadeDirectory, { recursive: true });
  rmSync(join(facadeDirectory, "src", libraryFile), { force: true });
  const manifestPath = join(facadeDirectory, "package.json");
  writable(manifestPath);
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
  run("bun", [
    resolve(root, nodeGenerator),
    "--root",
    root,
    "--crate",
    crate,
    "--node",
    facadeDirectory,
    "--cargo-target",
    required("cargo-target"),
    "--node-package-base",
    `${nodePackage}-`,
    "--skip-build",
  ]);
  mkdirSync(resolve(output, "npm-facade"), { recursive: true });
  run(
    "npm",
    ["pack", "--pack-destination", resolve(output, "npm-facade")],
    facadeDirectory,
  );
};

const packagePython = ({
  crate,
  library,
  output,
  pythonDirectory,
  pythonTag,
  version,
}) => {
  const pythonRoot = resolve(output, "python-root");
  cpSync(resolve(root, pythonDirectory), pythonRoot, { recursive: true });
  const pyproject = join(pythonRoot, "pyproject.toml");
  writable(pyproject);
  writeFileSync(pyproject, replaceVersion(readFileSync(pyproject, "utf8"), version));

  const packageName = crate.replace(/^dbx-tools-/, "").replaceAll("-", "_");
  const packageDirectory = resolve(pythonRoot, "src", "dbx_tools", packageName);
  const generatedDirectory = mkdtempSync(join(tmpdir(), `${packageName}-python-`));
  run("cargo", [
    "run",
    "--release",
    "--package",
    crate,
    "--bin",
    "uniffi-bindgen",
    "--",
    "generate",
    "--language",
    "python",
    "--out-dir",
    generatedDirectory,
    library,
  ]);
  const bindings = join(packageDirectory, "bindings.py");
  writable(bindings);
  const body = readFileSync(join(generatedDirectory, `${crate.replaceAll("-", "_")}.py`), "utf8");
  writeFileSync(
    bindings,
    [
      "# GENERATED by UniFFI binding generation - DO NOT EDIT.",
      `# Regenerated from the ${crate} Rust exports.`,
      "# Hand edits are overwritten on the next watch; this file is read-only.",
      "",
      body,
    ].join("\n"),
  );
  cpSync(library, join(packageDirectory, basename(library)));
  rmSync(generatedDirectory, { recursive: true, force: true });

  const wheelDirectory = resolve(output, "python");
  mkdirSync(wheelDirectory, { recursive: true });
  run("uv", ["build", "--wheel", "--out-dir", wheelDirectory], pythonRoot);
  const wheels = readdirSync(wheelDirectory).filter((file) => file.endsWith(".whl"));
  if (wheels.length !== 1) throw new Error(`Expected one Python wheel, found ${wheels.length}`);
  run("uvx", [
    "--from",
    "wheel",
    "wheel",
    "tags",
    "--remove",
    "--platform-tag",
    pythonTag,
    join(wheelDirectory, wheels[0]),
  ]);
};

const build = () => {
  const crate = required("crate");
  const cargoTarget = required("cargo-target");
  const nodeTriple = required("node-triple");
  const pythonTag = required("python-tag");
  const version = required("version");
  const os = required("os");
  const cpu = required("cpu");
  const output = resolve(root, required("output"));
  const library = libraryPath(crate, cargoTarget, os);

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  if (!parsed.values["skip-build"]) {
    run("cargo", ["build", "--release", "--package", crate, "--target", cargoTarget]);
  }
  if (!existsSync(library)) throw new Error(`Missing native library ${library}`);

  const nodeDirectory = parsed.values.node;
  const nodePackage = parsed.values["node-package"];
  if (nodeDirectory && nodePackage) {
    packageNode({
      crate,
      library,
      output,
      nodeDirectory,
      nodePackage,
      nodeTriple,
      os,
      cpu,
      version,
      facade: parsed.values.facade === "true",
      nodeGenerator: required("node-generator"),
    });
  }

  const pythonDirectory = parsed.values.python;
  if (pythonDirectory) {
    packagePython({
      crate,
      library,
      output,
      pythonDirectory,
      pythonTag,
      version,
    });
  }
};

if (parsed.positionals[0] !== "build") throw new Error("Expected build command");
build();
