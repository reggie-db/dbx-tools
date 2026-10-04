/** Shared pyproject-backed configuration for PythonMonkey Node bindings. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { object } from "@dbx-tools/shared-core";
import type { Project } from "projen";
import { parse } from "smol-toml";
import { workspaceDependencyDirectories } from "./packages.ts";

export interface ResolvedPythonNodeFunctionOverride {
  readonly handlerExport: string;
  readonly handlerFile: string;
  readonly targetExport: string;
  readonly targetModule: string;
}

export interface ResolvedPythonNodeBindings {
  readonly bindingsPackageOutput: string;
  readonly bindingsOutput: string;
  readonly functionOverrides: readonly ResolvedPythonNodeFunctionOverride[];
  readonly entrypoint: string;
  readonly moduleDirectory: string;
  readonly layout: "package" | "submodule";
  readonly private: boolean;
  readonly package: string;
  readonly project: string;
  readonly projectDirectory: string;
  readonly pyproject: string;
  readonly runtimeOutput: string;
  readonly shimRoot?: string;
  readonly workspaceDirectories: readonly string[];
}

/** Resolve one Python package's Node binding configuration and conventional outputs. */
export function resolvePythonNodeBindings(
  root: string,
  project: string,
): ResolvedPythonNodeBindings {
  const projectDirectory = resolve(root, project);
  const pyproject = resolve(projectDirectory, "pyproject.toml");
  const manifest = record(parse(readFileSync(pyproject, "utf8")), "pyproject.toml");
  const tool = record(manifest.tool, "tool");
  const dbxTools = record(tool.dbx_tools, "tool.dbx_tools");
  const bindings = record(dbxTools.node_bindings, "tool.dbx_tools.node_bindings");
  const uv = record(tool.uv, "tool.uv");
  const backend = record(uv["build-backend"], "tool.uv.build-backend");
  const packageName = requiredString(bindings.package, "tool.dbx_tools.node_bindings.package");
  const entrypoint =
    optionalString(bindings.entrypoint, "tool.dbx_tools.node_bindings.entrypoint") ?? packageName;
  const layout = nodeBindingsLayout(bindings.layout);
  const moduleName = requiredString(backend["module-name"], "tool.uv.build-backend.module-name");
  const moduleRoot = requiredString(backend["module-root"], "tool.uv.build-backend.module-root");
  const configuredOverrides = bindings.function_overrides ?? [];
  if (!Array.isArray(configuredOverrides)) {
    throw new Error("tool.dbx_tools.node_bindings.function_overrides must be an array");
  }
  const moduleDirectory = resolve(projectDirectory, moduleRoot, ...moduleName.split("."));
  const generatedDirectory =
    layout === "package" ? moduleDirectory : join(moduleDirectory, "_generated");
  const shimRoot = optionalString(bindings.shim_root, "tool.dbx_tools.node_bindings.shim_root");
  return {
    project,
    projectDirectory,
    pyproject,
    package: packageName,
    entrypoint,
    layout,
    private: optionalBoolean(bindings.private, "tool.dbx_tools.node_bindings.private") ?? false,
    moduleDirectory,
    runtimeOutput: join(generatedDirectory, "_runtime.js"),
    bindingsOutput: join(generatedDirectory, "node_bindings.py"),
    bindingsPackageOutput: join(generatedDirectory, "__init__.py"),
    ...(shimRoot ? { shimRoot: resolve(root, shimRoot) } : {}),
    functionOverrides: configuredOverrides.map((candidate, index) => {
      const path = `tool.dbx_tools.node_bindings.function_overrides[${index}]`;
      const override = record(candidate, path);
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
}

function nodeBindingsLayout(value: unknown): "package" | "submodule" {
  if (value === undefined) return "submodule";
  if (value === "package" || value === "submodule") return value;
  throw new Error("tool.dbx_tools.node_bindings.layout must be package or submodule");
}

/** All paths that can change a workspace-backed generated Node runtime. */
export function pythonNodeBindingWatchInputs(config: ResolvedPythonNodeBindings): string[] {
  if (config.workspaceDirectories.length === 0) {
    throw new Error(`${config.package} is not a workspace package and cannot be watched`);
  }
  return [
    config.pyproject,
    ...config.workspaceDirectories,
    ...(config.shimRoot ? [config.shimRoot] : []),
    ...config.functionOverrides.map(({ handlerFile }) => handlerFile),
  ];
}

/** Whether a Projen tree already contains the configured Node package. */
export function hasWorkspaceNodePackage(project: Project, packageName: string): boolean {
  return (
    project.name === packageName || project.subprojects.some((child) => child.name === packageName)
  );
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

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}
