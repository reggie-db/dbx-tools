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
    "native-package": { type: "string" },
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
const commandInvocation = (command, args) => {
  if (process.platform !== "win32" || command !== "npm") return { command, args };
  const npmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error(`Missing npm CLI ${npmCli}`);
  return { command: process.execPath, args: [npmCli, ...args] };
};
const run = (command, args, cwd = root) => {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, { cwd, stdio: "inherit" });
  if (result.error) {
    throw new Error(`${invocation.command} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) throw new Error(`${invocation.command} exited with ${result.status}`);
};

const singlePackage = (directory) => {
  const packages = readdirSync(directory)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => resolve(directory, file));
  if (packages.length !== 1) {
    throw new Error(`Expected one npm package in ${directory}, found ${packages.length}`);
  }
  return packages[0];
};

const localWorkspacePackages = () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : [];
  return new Map(
    workspaces.flatMap((directory) => {
      const manifestPath = resolve(root, directory, "package.json");
      if (!existsSync(manifestPath)) return [];
      const workspaceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return workspaceManifest.name ? [[workspaceManifest.name, workspaceManifest.version]] : [];
    }),
  );
};

/**
 * Read one bundled facade's static imports so local workspace dependency stubs
 * expose every requested ESM name. Callable proxy values support module helpers
 * and base classes that execute while the facade is imported.
 */
const importedNames = (source, packageName) => {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)import\\s+([^;]+?)\\s+from\\s+["']${escaped}["'];`, "g");
  const names = new Set();
  let hasDefault = false;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1].trim();
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
    if (named) {
      for (const specifier of named.split(",")) {
        const name = specifier.trim().split(/\s+as\s+/)[0];
        if (name) names.add(name);
      }
    }
    const beforeNamed = clause.split(/[,{\s]/, 1)[0];
    if (beforeNamed && beforeNamed !== "*" && !clause.startsWith("{")) hasDefault = true;
  }
  return { names: [...names].sort(), hasDefault };
};

const testNodeFacade = ({
  facadeDirectory,
  facadePackage,
  manifest,
  nativePackage,
  nodePackage,
}) => {
  const installDirectory = mkdtempSync(join(tmpdir(), "uniffi-facade-install-"));
  try {
    const workspacePackages = localWorkspacePackages();
    const facadeSource = readFileSync(join(facadeDirectory, "lib", "index.js"), "utf8");
    const bindings =
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dbxToolsConfig?.rust?.bindings ??
      [];
    const localDependencies = Object.keys(manifest.dependencies ?? {}).flatMap((name, index) => {
      const workspaceVersion = workspacePackages.get(name);
      if (!workspaceVersion) return [];
      const binding = bindings.find((binding) => binding.nodePackage === name);
      if (binding) {
        const output = resolve(root, "dist/release", binding.crate, required("node-triple"));
        if (existsSync(join(output, "npm-facade")) && existsSync(join(output, "npm"))) {
          return [singlePackage(join(output, "npm-facade")), singlePackage(join(output, "npm"))];
        }
        return [];
      }
      const directory = join(installDirectory, "local-dependencies", String(index));
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        `${JSON.stringify({
          name,
          version: workspaceVersion,
          type: "module",
          exports: "./index.js",
        })}\n`,
      );
      const imports = importedNames(facadeSource, name);
      writeFileSync(
        join(directory, "index.js"),
        [
          "const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });",
          ...imports.names.map((name) => `export const ${name} = stub;`),
          ...(imports.hasDefault ? ["export default stub;"] : []),
          "",
        ].join("\n"),
      );
      return [directory];
    });
    writeFileSync(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" })}\n`,
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        facadePackage,
        nativePackage,
        ...localDependencies,
      ],
      installDirectory,
    );
    run("node", ["-e", `import(${JSON.stringify(nodePackage)})`], installDirectory);
  } finally {
    rmSync(installDirectory, { recursive: true, force: true });
  }
};

const replaceVersion = (source, version) =>
  source.replace(/^version = "[^"]+"$/m, `version = "${version}"`);

/** Resolve workspace and generated catalog protocols for a publishable facade. */
const facadeDependency = (name, dependency, version, catalog) => {
  if (typeof dependency !== "string") return dependency;
  if (dependency.startsWith("workspace:")) return version;
  if (!dependency.startsWith("catalog:")) return dependency;
  const resolved = catalog[name];
  if (!resolved) throw new Error(`Missing root catalog entry for ${name}`);
  return resolved;
};

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
  library,
  output,
  nodeDirectory,
  nodePackage,
  nodeTriple,
  os,
  cpu,
  version,
  facade,
}) => {
  const libraryFile = basename(library);
  const sourceManifest = JSON.parse(
    readFileSync(resolve(root, nodeDirectory, "package.json"), "utf8"),
  );
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
        repository: sourceManifest.repository,
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
  packageNodeFacade({
    output,
    nodeDirectory,
    nodePackage,
    version,
    nativePackage: singlePackage(resolve(output, "npm")),
  });
};

const packageNodeFacade = ({ output, nodeDirectory, nodePackage, version, nativePackage }) => {
  const facadeDirectory = resolve(output, "facade-node");
  rmSync(facadeDirectory, { recursive: true, force: true });
  rmSync(resolve(output, "npm-facade"), { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(resolve(root, nodeDirectory), facadeDirectory, { recursive: true });
  const barrel = join(facadeDirectory, "index.ts");
  writable(barrel);
  writeFileSync(
    barrel,
    readFileSync(barrel, "utf8").replace(
      /^export const PACKAGE_VERSION = .*;$/m,
      `export const PACKAGE_VERSION = ${JSON.stringify(version)};`,
    ),
  );
  for (const file of readdirSync(join(facadeDirectory, "src"))) {
    if (/\.(dll|dylib|so)$/.test(file)) {
      rmSync(join(facadeDirectory, "src", file), { force: true });
    }
  }
  const manifestPath = join(facadeDirectory, "package.json");
  writable(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const workspaceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const catalog = workspaceManifest.catalog ?? {};
  manifest.version = version;
  manifest.private = false;
  manifest.license = manifest.license === "UNLICENSED" ? "Apache-2.0" : manifest.license;
  manifest.optionalDependencies = Object.fromEntries(
    Object.keys(manifest.optionalDependencies ?? {}).map((name) => [name, version]),
  );
  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, dependency]) => [
      name,
      facadeDependency(name, dependency, version, catalog),
    ]),
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Node loads the facade from node_modules, so every TypeScript entry point
  // must be emitted and advertised as JavaScript.
  rmSync(join(facadeDirectory, "lib"), { recursive: true, force: true });
  run(
    "bun",
    [
      "build",
      "index.ts",
      "--outdir",
      "lib",
      "--target",
      "node",
      "--format",
      "esm",
      "--packages",
      "external",
    ],
    facadeDirectory,
  );
  const compiledPublish = { ...(manifest.publishConfig ?? {}) };
  delete compiledPublish.access;
  Object.assign(manifest, compiledPublish);
  manifest.types = "./index.ts";
  manifest.exports["."].types = "./index.ts";
  delete manifest.publishConfig;
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const facadeOutput = resolve(output, "npm-facade");
  mkdirSync(facadeOutput, { recursive: true });
  run("npm", ["pack", "--pack-destination", facadeOutput], facadeDirectory);
  if (nativePackage) {
    testNodeFacade({
      facadeDirectory,
      facadePackage: singlePackage(facadeOutput),
      manifest,
      nativePackage,
      nodePackage,
    });
  }
};

const packagePython = ({
  crate,
  library,
  output,
  pythonDirectory,
  pythonTag,
  version,
  cargoTarget,
  os,
}) => {
  const pythonRoot = resolve(output, "python-root");
  cpSync(resolve(root, pythonDirectory), pythonRoot, { recursive: true });
  const pyproject = join(pythonRoot, "pyproject.toml");
  writable(pyproject);
  writeFileSync(pyproject, replaceVersion(readFileSync(pyproject, "utf8"), version));
  const workspaceBindings =
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dbxToolsConfig?.rust?.bindings ??
    [];
  let metadata = readFileSync(pyproject, "utf8");
  for (const binding of workspaceBindings) {
    if (!binding.pythonPackage) continue;
    const escaped = binding.pythonPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    metadata = metadata.replace(
      new RegExp(`"${escaped} @ git\\+[^"\\n]+"`, "g"),
      JSON.stringify(`${binding.pythonPackage}==${version}`),
    );
  }
  writeFileSync(pyproject, metadata);

  const packageName = crate.replace(/^dbx-tools-/, "").replaceAll("-", "_");
  const packageDirectory = resolve(pythonRoot, "src", "dbx_tools", packageName);
  const generatedDirectory = mkdtempSync(join(tmpdir(), `${packageName}-python-`));
  const generator = resolve(
    root,
    "target",
    cargoTarget,
    "release",
    `${crate}-uniffi-bindgen${os === "win32" ? ".exe" : ""}`,
  );
  if (!existsSync(generator)) throw new Error(`Missing UniFFI generator ${generator}`);
  run(generator, [
    "generate",
    "--language",
    "python",
    "--crate",
    crate.replaceAll("-", "_"),
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
      library,
      output,
      nodeDirectory,
      nodePackage,
      nodeTriple,
      os,
      cpu,
      version,
      facade: parsed.values.facade === "true",
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
      cargoTarget,
      os,
    });
  }
};

if (parsed.positionals[0] === "build") {
  build();
} else if (parsed.positionals[0] === "facade") {
  packageNodeFacade({
    output: resolve(root, required("output")),
    nodeDirectory: required("node"),
    nodePackage: required("node-package"),
    version: required("version"),
    nativePackage: parsed.values["native-package"]
      ? resolve(root, parsed.values["native-package"])
      : undefined,
  });
} else {
  throw new Error("Expected build or facade command");
}
