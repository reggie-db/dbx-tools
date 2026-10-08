/** Shared pyproject-backed configuration for PythonMonkey Node bindings. */
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { find } from "@dbx-tools/path";
import { object, stringUtils } from "@dbx-tools/shared-core";
import { parse } from "smol-toml";
import ts from "typescript";
import { runTaskCommand } from "./_task-command.ts";
import { resolveRepoRoot, workspaceDependencyDirectories } from "./packages.ts";

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
}

/** Generate or verify every pyproject-configured Node binding in a repository. */
export function generatePythonNodeBindings(
  projectRoot: string = resolveRepoRoot(),
  options: GeneratePythonNodeBindingsOptions = {},
): void {
  const task = resolve(dirname(fileURLToPath(import.meta.url)), "../tasks/python-node-bindings.ts");
  const configuredProjects = pythonNodeBindingProjects(projectRoot);
  const directories = new Set<string>();
  for (const project of configuredProjects) {
    for (const config of resolvePythonNodeBindings(projectRoot, project)) {
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
  for (const project of configuredProjects) {
    runTaskCommand(projectRoot, "bun", [
      task,
      "--root",
      projectRoot,
      "--project",
      project,
      ...(options.check ? ["--check"] : []),
    ]);
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
  for (const file of find.findFiles("**/_generated/node/**/*", {
    cwd: projectRoot,
    ignore: () => false,
  })) {
    const segments = file.split("/");
    const generated = segments.lastIndexOf("_generated");
    if (generated >= 0 && segments[generated + 1] === "node") {
      directories.add(segments.slice(0, generated + 2).join("/"));
    }
  }
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
  const allowed = config.workspaceDirectories.map(canonicalPath);
  const packageEntrypoint = Bun.resolveSync(config.entrypoint, config.projectDirectory);
  const entrypoints =
    config.modules.length > 0
      ? config.modules.map((module) => resolvePythonNodeBindingModule(packageEntrypoint, module))
      : [packageEntrypoint];
  const pending = [
    ...entrypoints,
    ...config.functionOverrides.map(({ handlerFile }) => handlerFile),
  ];
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
  return [...visited].sort().map((path) => relative(root, path));
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
