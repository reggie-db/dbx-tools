/** Shared pyproject-backed configuration for PythonMonkey Node bindings. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { find } from "@dbx-tools/path";
import { object, stringUtils } from "@dbx-tools/shared-core";
import { parse } from "smol-toml";
import ts from "typescript";
import { runTaskCommand } from "./_task-command.ts";
import { makeReadonly } from "./generated.ts";
import { publicFunctionExports, publicNamespaceExports } from "./module-exports.ts";
import { resolveRepoRoot, workspaceDependencyDirectories } from "./packages.ts";

const FINGERPRINT_VERSION = 5;
const INPUT_FINGERPRINT_LABEL = "dbx-tools binding inputs sha256";
const CONTENT_FINGERPRINT_LABEL = "dbx-tools binding content sha256";
const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

/** Resolved function replacement consumed while generating one PythonMonkey bundle. */
export interface ResolvedPythonNodeFunctionOverride {
  readonly handlerExport: string;
  readonly handlerFile: string;
  readonly targetExport: string;
  readonly targetModule: string;
}

/** Fully resolved pyproject binding configuration consumed by the runtime generator. */
export interface ResolvedPythonNodeBindings {
  readonly bindingDirectory: string;
  readonly bindingName: string;
  readonly functionOverrides: readonly ResolvedPythonNodeFunctionOverride[];
  readonly entrypoint: string;
  readonly moduleDirectory: string;
  readonly modules: readonly string[];
  readonly package: string;
  readonly project: string;
  readonly projectDirectory: string;
  readonly pyproject: string;
  readonly runtimeOutput: string;
  readonly watchInputs: readonly string[];
  readonly workspaceDirectories: readonly string[];
}

/** Options for repository-wide Python Node binding generation. */
export interface GeneratePythonNodeBindingsOptions {
  /** Verify generated output without changing it. */
  readonly check?: boolean;
  /** Regenerate outputs without consulting fingerprints. */
  readonly force?: boolean;
}

/** Generate or verify every pyproject-configured Node binding in a repository. */
export function generatePythonNodeBindings(
  projectRoot: string = resolveRepoRoot(),
  options: GeneratePythonNodeBindingsOptions = {},
): void {
  const task = resolve(dirname(fileURLToPath(import.meta.url)), "../tasks/python-node-bindings.ts");
  const force = options.force ?? process.env.CI === "true";
  const configuredProjects = pythonNodeBindingProjects(projectRoot).map((project) => ({
    project,
    configs: resolvePythonNodeBindings(projectRoot, project).map(resolvePythonNodeBindingModules),
  }));
  const directories = new Set<string>();
  for (const { configs } of configuredProjects) {
    for (const config of configs) {
      directories.add(relative(projectRoot, join(config.moduleDirectory, "_generated", "node")));
    }
  }
  const stale = existingBindingDirectories(projectRoot).filter(
    (directory) => !directories.has(directory),
  );
  if (stale.length > 0 && options.check) {
    throw new Error(
      `Generated Node binding directories are stale:\n${stale.map((directory) => `  ${directory}`).join("\n")}`,
    );
  }
  for (const directory of stale) {
    rmSync(resolve(projectRoot, directory), { recursive: true, force: true });
  }
  for (const { configs, project } of configuredProjects) {
    const inputFingerprint = pythonNodeBindingInputFingerprint(projectRoot, configs);
    if (!force && pythonNodeBindingOutputsCurrent(configs, inputFingerprint)) {
      for (const output of pythonNodeBindingOutputs(configs)) makeReadonly(output);
      continue;
    }
    runTaskCommand(projectRoot, "bun", [
      task,
      "--root",
      projectRoot,
      "--project",
      project,
      ...(options.check ? ["--check"] : []),
      ...(force ? ["--force"] : []),
    ]);
  }
}

/** Resolve automatically discovered bindable namespaces for one configured package. */
export function resolvePythonNodeBindingModules(
  config: ResolvedPythonNodeBindings,
): ResolvedPythonNodeBindings {
  if (config.modules.length > 0) return config;
  const packageEntrypoint = Bun.resolveSync(config.entrypoint, config.projectDirectory);
  const modules = publicNamespaceExports(packageEntrypoint).filter(
    (module) =>
      publicFunctionExports(resolvePythonNodeBindingModule(packageEntrypoint, module)).length > 0,
  );
  return { ...config, modules };
}

/** Map a JavaScript export or namespace to its generated Python identifier. */
export function pythonNodeBindingFunctionName(javascriptName: string): string {
  const name = stringUtils.toIdentifierWithOptions({ delimiter: "_" }, javascriptName);
  if (!isPythonNodeBindingIdentifier(name)) {
    throw new Error(
      `JavaScript export ${javascriptName} does not map to a valid Python function name`,
    );
  }
  return name;
}

/** Whether a value is a legal non-keyword Python identifier. */
export function isPythonNodeBindingIdentifier(value: string): boolean {
  return /^[_A-Za-z]\w*$/.test(value) && !PYTHON_KEYWORDS.has(value);
}

/** Content fingerprint for every source and toolchain input affecting generated bindings. */
export function pythonNodeBindingInputFingerprint(
  root: string,
  configs: readonly ResolvedPythonNodeBindings[],
): string {
  const canonicalRoot = canonicalPath(root);
  const fingerprintPath = (path: string): string => relative(canonicalRoot, canonicalPath(path));
  const sourceFile = canonicalPath(fileURLToPath(import.meta.url));
  const sourceDirectory = dirname(sourceFile);
  const files = new Set<string>([
    sourceFile,
    canonicalPath(resolve(sourceDirectory, "../tasks/python-node-bindings.ts")),
    canonicalPath(join(sourceDirectory, "generated.ts")),
    canonicalPath(join(sourceDirectory, "module-exports.ts")),
    canonicalPath(join(sourceDirectory, "packages.ts")),
    canonicalPath(join(sourceDirectory, "python-node-runtime.ts")),
  ]);
  const versionFile = join(root, "VERSION");
  if (existsSync(versionFile)) files.add(canonicalPath(versionFile));
  for (const config of configs) {
    for (const input of config.watchInputs) files.add(canonicalPath(resolve(root, input)));
    for (const { handlerFile } of config.functionOverrides) files.add(canonicalPath(handlerFile));
    const packageEntrypoint = canonicalPath(
      Bun.resolveSync(config.entrypoint, config.projectDirectory),
    );
    files.add(packageEntrypoint);
    const packageManifest = nearestPackageManifest(packageEntrypoint);
    if (packageManifest) files.add(canonicalPath(packageManifest));
    for (const module of config.modules) {
      files.add(canonicalPath(resolvePythonNodeBindingModule(packageEntrypoint, module)));
    }
  }

  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      configs: configs.map((config) => ({
        bindingDirectory: fingerprintPath(config.bindingDirectory),
        bindingName: config.bindingName,
        entrypoint: config.entrypoint,
        functionOverrides: config.functionOverrides.map((override) => ({
          handlerExport: override.handlerExport,
          handlerFile: fingerprintPath(override.handlerFile),
          targetExport: override.targetExport,
          targetModule: override.targetModule,
        })),
        moduleDirectory: fingerprintPath(config.moduleDirectory),
        modules: config.modules,
        package: config.package,
        project: config.project,
        runtimeOutput: fingerprintPath(config.runtimeOutput),
      })),
      format: FINGERPRINT_VERSION,
    }),
  );
  for (const { file, path } of [...files]
    .map((file) => ({ file, path: fingerprintPath(file) }))
    .sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update("\0file\0");
    hash.update(path);
    hash.update("\0");
    hash.update(existsSync(file) ? readFileSync(file) : "<missing>");
  }
  return hash.digest("hex");
}

/** Complete generated output set for one Python project's Node bindings. */
export function pythonNodeBindingOutputs(configs: readonly ResolvedPythonNodeBindings[]): string[] {
  const nodeDirectory = pythonNodeBindingDirectory(configs);
  return [
    join(nodeDirectory, "_runtime.js"),
    join(nodeDirectory, "_runtime.py"),
    ...configs.flatMap((config) =>
      config.modules.length > 0
        ? config.modules.map((module) =>
            join(config.bindingDirectory, `${pythonNodeBindingFunctionName(module)}.py`),
          )
        : [join(config.bindingDirectory, "index.py")],
    ),
  ].sort();
}

/** Whether all expected outputs exactly match their input and body fingerprints. */
export function pythonNodeBindingOutputsCurrent(
  configs: readonly ResolvedPythonNodeBindings[],
  inputFingerprint: string,
): boolean {
  const generatedPackage = join(configs[0]!.moduleDirectory, "_generated", "__init__.py");
  if (existsSync(generatedPackage)) return false;
  const expected = pythonNodeBindingOutputs(configs);
  const actual = filesBelow(pythonNodeBindingDirectory(configs)).sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    return false;
  }
  return expected.every((output) => pythonNodeBindingFingerprintCurrent(output, inputFingerprint));
}

/** Prefix generated output with its input fingerprint and a self-validating body digest. */
export function fingerprintPythonNodeBindingOutput(
  contents: string,
  inputFingerprint: string,
  output: string,
): string {
  const prefix = output.endsWith(".py") ? "#" : "//";
  const contentFingerprint = createHash("sha256").update(contents).digest("hex");
  return [
    `${prefix} ${INPUT_FINGERPRINT_LABEL}: ${inputFingerprint}`,
    `${prefix} ${CONTENT_FINGERPRINT_LABEL}: ${contentFingerprint}`,
    contents,
  ].join("\n");
}

function pythonNodeBindingDirectory(configs: readonly ResolvedPythonNodeBindings[]): string {
  const moduleDirectory = configs[0]?.moduleDirectory;
  if (!moduleDirectory) throw new Error("Expected at least one Node binding configuration");
  return join(moduleDirectory, "_generated", "node");
}

function pythonNodeBindingFingerprintCurrent(output: string, inputFingerprint: string): boolean {
  try {
    const [inputLine, contentLine, ...bodyLines] = readFileSync(output, "utf8").split("\n");
    const prefix = output.endsWith(".py") ? "#" : "//";
    if (inputLine !== `${prefix} ${INPUT_FINGERPRINT_LABEL}: ${inputFingerprint}`) return false;
    const escapedPrefix = prefix === "//" ? "\\/\\/" : "#";
    const expectedContent = contentLine?.match(
      new RegExp(`^${escapedPrefix} ${CONTENT_FINGERPRINT_LABEL}: ([a-f0-9]{64})$`),
    )?.[1];
    if (!expectedContent) return false;
    return createHash("sha256").update(bodyLines.join("\n")).digest("hex") === expectedContent;
  } catch {
    return false;
  }
}

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function nearestPackageManifest(path: string): string | undefined {
  let directory = dirname(path);
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) return manifest;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Resolve every configured binding in a repository. */
export function resolveAllPythonNodeBindings(
  projectRoot: string = resolveRepoRoot(),
): ResolvedPythonNodeBindings[] {
  return pythonNodeBindingProjects(projectRoot).flatMap((project) =>
    resolvePythonNodeBindings(projectRoot, project),
  );
}

/** Repository-relative Python projects that configure generated Node bindings. */
export function pythonNodeBindingProjects(projectRoot: string): string[] {
  return [
    ...find
      .findFiles("**/pyproject.toml", { cwd: projectRoot })
      .filter((file) => {
        const manifest = parse(readFileSync(resolve(projectRoot, file), "utf8")) as {
          tool?: { dbx_tools?: { node_bindings?: unknown } };
        };
        return manifest.tool?.dbx_tools?.node_bindings !== undefined;
      })
      .map((file) => dirname(file)),
  ].sort();
}

function existingBindingDirectories(projectRoot: string): string[] {
  const directories = new Set<string>();
  const ignored = new Set([
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
  ]);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name === "node" && basename(directory) === "_generated") {
        directories.add(relative(projectRoot, path));
        continue;
      }
      visit(path);
    }
  };
  visit(projectRoot);
  return [...directories].sort();
}

/** Resolve one Python package's Node binding configurations and conventional outputs. */
export function resolvePythonNodeBindings(
  root: string,
  project: string,
): ResolvedPythonNodeBindings[] {
  const projectDirectory = resolve(root, project);
  const pyproject = resolve(projectDirectory, "pyproject.toml");
  const manifest = record(parse(readFileSync(pyproject, "utf8")), "pyproject.toml");
  const tool = record(manifest.tool, "tool");
  const dbxTools = record(tool.dbx_tools, "tool.dbx_tools");
  const configuredBindings = Array.isArray(dbxTools.node_bindings)
    ? dbxTools.node_bindings
    : [dbxTools.node_bindings];
  if (configuredBindings.length === 0) {
    throw new Error("tool.dbx_tools.node_bindings must contain at least one table");
  }
  const uv = record(tool.uv, "tool.uv");
  const backend = record(uv["build-backend"], "tool.uv.build-backend");
  const moduleName = requiredString(backend["module-name"], "tool.uv.build-backend.module-name");
  const moduleRoot = requiredString(backend["module-root"], "tool.uv.build-backend.module-root");
  const moduleDirectory = resolve(projectDirectory, moduleRoot, ...moduleName.split("."));
  const configs = configuredBindings.map((candidate, bindingIndex) => {
    const bindingPath = Array.isArray(dbxTools.node_bindings)
      ? `tool.dbx_tools.node_bindings[${bindingIndex}]`
      : "tool.dbx_tools.node_bindings";
    const bindings = record(candidate, bindingPath);
    const packageName = requiredString(bindings.package, `${bindingPath}.package`);
    const entrypoint =
      optionalString(bindings.entrypoint, `${bindingPath}.entrypoint`) ?? packageName;
    const modules = optionalStrings(bindings.modules, `${bindingPath}.modules`);
    if (bindings.layout !== undefined || bindings.private !== undefined) {
      throw new Error(`${bindingPath} no longer supports layout or private`);
    }
    const configuredOverrides = bindings.function_overrides ?? [];
    if (!Array.isArray(configuredOverrides)) {
      throw new Error(`${bindingPath}.function_overrides must be an array`);
    }
    const bindingName = nodePackageName(packageName);
    const bindingDirectory = join(moduleDirectory, "_generated", "node", bindingName);
    const resolved = {
      project,
      projectDirectory,
      pyproject,
      package: packageName,
      entrypoint,
      modules,
      bindingName,
      bindingDirectory,
      moduleDirectory,
      runtimeOutput: join(moduleDirectory, "_generated", "node", "_runtime.js"),
      functionOverrides: configuredOverrides.map((overrideCandidate, overrideIndex) => {
        const path = `${bindingPath}.function_overrides[${overrideIndex}]`;
        const override = record(overrideCandidate, path);
        const targetExport = requiredString(override.export, `${path}.export`);
        return {
          targetModule: requiredString(override.module, `${path}.module`),
          targetExport,
          handlerFile: resolve(root, requiredString(override.handler, `${path}.handler`)),
          handlerExport:
            optionalString(override.handler_export, `${path}.handler_export`) ?? targetExport,
        };
      }),
      workspaceDirectories: workspaceDependencyDirectories(packageName, root),
    };
    return {
      ...resolved,
      watchInputs: bindingSourceInputs(root, resolved),
    };
  });
  validateBindings(configs);
  return configs;
}

type BindingSourceConfig = Omit<ResolvedPythonNodeBindings, "watchInputs">;

/** Transitive workspace source files reachable from configured binding modules. */
function bindingSourceInputs(root: string, config: BindingSourceConfig): string[] {
  const packageEntrypoint = Bun.resolveSync(config.entrypoint, config.projectDirectory);
  const entrypoints =
    config.modules.length > 0
      ? config.modules.map((module) => resolvePythonNodeBindingModule(packageEntrypoint, module))
      : [packageEntrypoint];
  return transitiveSourceFiles(
    [...entrypoints, ...config.functionOverrides.map(({ handlerFile }) => handlerFile)],
    config.workspaceDirectories,
  ).map((path) => relative(root, path));
}

function transitiveSourceFiles(
  entrypoints: readonly string[],
  allowedDirectories: readonly string[],
): string[] {
  const allowed = allowedDirectories.map(canonicalPath);
  const pending = [...entrypoints];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = canonicalPath(pending.pop()!);
    if (
      visited.has(candidate) ||
      !allowed.some((directory) => containsResolvedPath(directory, candidate))
    ) {
      continue;
    }
    visited.add(candidate);
    let source: string;
    try {
      source = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    const dependencies = ts.preProcessFile(source, true, true).importedFiles;
    for (const dependency of dependencies) {
      try {
        pending.push(Bun.resolveSync(dependency.fileName, dirname(candidate)));
      } catch {
        // Built-ins and external packages are outside the workspace source graph.
      }
    }
  }
  return [...visited].sort();
}

/** Resolve one configured namespace from a package entrypoint barrel. */
export function resolvePythonNodeBindingModule(entrypoint: string, module: string): string {
  if (!/^[$A-Z_a-z][$\w]*$/.test(module)) {
    throw new Error(`Node binding module must be a TypeScript identifier: ${module}`);
  }
  const source = readFileSync(entrypoint, "utf8");
  const escaped = module.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  const match = new RegExp(`export\\s+\\*\\s+as\\s+${escaped}\\s+from\\s+["']([^"']+)["']`).exec(
    source,
  );
  if (!match?.[1]) {
    throw new Error(`${entrypoint} does not export namespace ${module}`);
  }
  return Bun.resolveSync(match[1], dirname(entrypoint));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function containsResolvedPath(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

/** All paths that can change a workspace-backed generated Node runtime. */
export function pythonNodeBindingWatchInputs(config: ResolvedPythonNodeBindings): string[] {
  if (config.workspaceDirectories.length === 0) {
    throw new Error(`${config.package} is not a workspace package and cannot be watched`);
  }
  return [
    config.pyproject,
    ...config.watchInputs,
    ...config.functionOverrides.map(({ handlerFile }) => handlerFile),
  ];
}

/**
 * Python projects whose generated runtimes depend on at least one changed path.
 *
 * The project list is computed once per watch batch and reused by the lock preflight
 * and generator callback. This keeps unrelated edits on the no-lock fast path while
 * ensuring each affected Python project is regenerated only once.
 */
export function affectedPythonNodeBindingProjects(
  root: string,
  configs: readonly ResolvedPythonNodeBindings[],
  changed: readonly string[],
): string[] {
  const affected = new Set<string>();
  for (const config of configs) {
    const inputs = pythonNodeBindingWatchInputs(config);
    if (changed.some((candidate) => inputs.some((input) => containsPath(root, input, candidate)))) {
      affected.add(config.project);
    }
  }
  return [...affected].sort();
}

/** Whether `candidate` is an input path or one of its descendants. */
function containsPath(root: string, input: string, candidate: string): boolean {
  const inputPath = resolve(root, input);
  const candidatePath = resolve(root, candidate);
  return candidatePath === inputPath || candidatePath.startsWith(`${inputPath}${sep}`);
}

function validateBindings(configs: readonly ResolvedPythonNodeBindings[]): void {
  const names = configs.map(({ bindingName }) => bindingName);
  if (new Set(names).size !== names.length) {
    throw new Error("tool.dbx_tools.node_bindings package names must be unique");
  }
  for (const config of configs) {
    if (new Set(config.modules).size !== config.modules.length) {
      throw new Error(`${config.package} Node binding module names must be unique`);
    }
  }
}

function nodePackageName(packageName: string): string {
  const unscoped = packageName.split("/").at(-1) ?? packageName;
  return stringUtils.toIdentifierWithOptions({ delimiter: "_" }, unscoped);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!object.isRecord(value)) throw new Error(`${path} must be a table`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  const parsed = optionalString(value, path);
  if (!parsed) throw new Error(`${path} must be a non-empty string`);
  return parsed;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalStrings(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [requiredString(value, path)];
  if (!Array.isArray(value)) throw new Error(`${path} must be a string or array`);
  return value.map((candidate, index) => requiredString(candidate, `${path}[${index}]`));
}
