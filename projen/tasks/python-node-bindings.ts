#!/usr/bin/env -S bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stringUtils } from "@dbx-tools/shared-core";
import type { BunPlugin } from "bun";
import stdLibBrowser from "node-stdlib-browser";
import { header, makeReadonly, makeWritable } from "../src/generated.ts";
import { publicFunctionExports } from "../src/module-exports.ts";
import {
  resolvePythonNodeBindings,
  type ResolvedPythonNodeFunctionOverride,
} from "../src/python-node-bindings.ts";

type FunctionOverride = ResolvedPythonNodeFunctionOverride;

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

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    project: { type: "string" },
    root: { type: "string" },
  },
});
if (!values.project) throw new Error("Expected --project <python-project-directory>");

const root = values.root
  ? resolve(values.root)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = resolvePythonNodeBindings(root, values.project);
const { bindingsOutput, projectDirectory, pyproject, runtimeOutput } = config;
const entrypoint = Bun.resolveSync(config.package, projectDirectory);
const functions = publicFunctionExports(entrypoint);
if (functions.length === 0) {
  throw new Error(`${config.package} exports no plain functions that can be bound to Python`);
}
const pythonFunctions = functions.map(({ name }) => ({
  javascriptName: name,
  pythonName: pythonFunctionName(name),
}));
const functionsByPythonName = new Map<string, string>();
for (const functionName of pythonFunctions) {
  const existing = functionsByPythonName.get(functionName.pythonName);
  if (existing && existing !== functionName.javascriptName) {
    throw new Error(
      `Python function name collision: ${existing} and ${functionName.javascriptName} both map to ${functionName.pythonName}`,
    );
  }
  functionsByPythonName.set(functionName.pythonName, functionName.javascriptName);
}

const shimRoot = config.shimRoot;
const overridesByModule = groupOverrides(config.functionOverrides);
const shimEntry = "dbx-tools:python-entry";
const functionOverrideNamespace = "dbx-tools-function-override";
const shimAliases = shimRoot
  ? new Map([
      ["child_process", resolve(shimRoot, "child-process.ts")],
      ["crypto", resolve(shimRoot, "crypto.ts")],
      ["fs", resolve(shimRoot, "fs.ts")],
      ["fs/promises", resolve(shimRoot, "fs-promises.ts")],
      ["os", resolve(shimRoot, "os.ts")],
      ["path", resolve(shimRoot, "path.ts")],
      ["process", resolve(shimRoot, "process.ts")],
      ["readline", resolve(shimRoot, "readline.ts")],
      ["stream/promises", resolve(shimRoot, "stream-promises.ts")],
      ["url", resolve(shimRoot, "url.ts")],
    ])
  : undefined;
const standardAliases = stdLibBrowser as Record<string, string | undefined>;
const runtimePlugin: BunPlugin | undefined =
  shimAliases || config.functionOverrides.length > 0
    ? {
        name: "python-node-runtime",
        setup(build) {
          if (shimRoot) {
            build.onResolve({ filter: /^dbx-tools:python-entry$/ }, () => ({
              path: shimEntry,
              namespace: "dbx-tools-python",
            }));
            build.onLoad({ filter: /.*/, namespace: "dbx-tools-python" }, () => ({
              contents: [
                `import ${JSON.stringify(resolve(shimRoot, "bootstrap.ts"))};`,
                `export * from ${JSON.stringify(entrypoint)};`,
              ].join("\n"),
              loader: "ts",
            }));
          }
          build.onLoad({ filter: /.*/, namespace: functionOverrideNamespace }, ({ path }) => {
            const overrides = overridesByModule.get(path);
            if (!overrides) throw new Error(`Missing function overrides for ${path}`);
            const realModule = Bun.resolveSync(path, dirname(entrypoint));
            return {
              contents: [
                `export * from ${JSON.stringify(realModule)};`,
                ...overrides.map(
                  (override) =>
                    `export { ${override.handlerExport} as ${override.targetExport} } from ${JSON.stringify(override.handlerFile)};`,
                ),
              ].join("\n"),
              loader: "ts",
            };
          });
          build.onResolve({ filter: /.*/ }, ({ path }) => {
            if (overridesByModule.has(path)) {
              return { path, namespace: functionOverrideNamespace };
            }
            if (!shimAliases) return undefined;
            const moduleName = path.replace(/^node:/, "");
            const shim = shimAliases.get(moduleName) ?? shimAliases.get(path);
            if (shim) return { path: shim };
            const standard = standardAliases[moduleName];
            return standard
              ? { path: Bun.resolveSync(standard, dirname(fileURLToPath(import.meta.url))) }
              : undefined;
          });
        },
      }
    : undefined;

const source = `${config.package} configured by ${relative(root, pyproject)}`;
await generate();

async function generate(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [shimRoot ? shimEntry : entrypoint],
    format: "cjs",
    ...(runtimePlugin ? { plugins: [runtimePlugin] } : {}),
    target: "browser",
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error(`Could not bundle ${config.package}`);
  }
  if (result.outputs.length !== 1) {
    throw new Error(`Expected one JavaScript bundle, received ${result.outputs.length}`);
  }

  const runtime = `${header({
    tool: "projen/tasks/python-node-bindings.ts",
    source,
  })}\n${await result.outputs[0].text()}`;
  const bindings = pythonBindings(source, pythonFunctions);
  writeGenerated(runtimeOutput, runtime, "JavaScript runtime");
  writeGenerated(bindingsOutput, bindings, "Python bindings");
}

function groupOverrides(
  overrides: readonly FunctionOverride[],
): ReadonlyMap<string, readonly FunctionOverride[]> {
  const grouped = new Map<string, FunctionOverride[]>();
  for (const override of overrides) {
    const current = grouped.get(override.targetModule) ?? [];
    if (current.some((candidate) => candidate.targetExport === override.targetExport)) {
      throw new Error(
        `Duplicate function override for ${override.targetModule}#${override.targetExport}`,
      );
    }
    current.push(override);
    grouped.set(override.targetModule, current);
  }
  return grouped;
}

function pythonFunctionName(javascriptName: string): string {
  const name = stringUtils.toIdentifierWithOptions({ delimiter: "_" }, javascriptName);
  if (!/^[_A-Za-z]\w*$/.test(name) || PYTHON_KEYWORDS.has(name)) {
    throw new Error(
      `JavaScript export ${javascriptName} does not map to a valid Python function name`,
    );
  }
  return name;
}

function pythonBindings(
  source: string,
  functions: readonly { javascriptName: string; pythonName: string }[],
): string {
  const exported = functions
    .map(({ pythonName }) => `    ${JSON.stringify(pythonName)},`)
    .join("\n");
  const wrappers = functions
    .map(
      ({ javascriptName, pythonName }) =>
        `async def ${pythonName}(*args: Any) -> Any:\n    return await _invoke(${JSON.stringify(javascriptName)}, *args)`,
    )
    .join("\n\n\n");
  return [
    "# GENERATED by projen/tasks/python-node-bindings.ts - DO NOT EDIT.",
    `# Regenerated from ${source}.`,
    "# Hand edits are overwritten; this file is read-only.",
    "",
    "from __future__ import annotations",
    "",
    "import inspect",
    "from pathlib import Path",
    "from typing import Any",
    "",
    "import pythonmonkey as pm",
    "import pythonmonkey.require",
    "",
    "_RUNTIME: Any | None = None",
    "",
    "",
    "def _runtime() -> Any:",
    "    global _RUNTIME",
    "    if _RUNTIME is None:",
    '        _RUNTIME = pm.require(str(Path(__file__).with_name("_runtime.js")))',
    "    return _RUNTIME",
    "",
    "",
    "async def _invoke(name: str, *args: Any) -> Any:",
    "    value = _runtime()[name](*args)",
    "    return await value if inspect.isawaitable(value) else value",
    "",
    "",
    wrappers,
    "",
    "",
    "__all__ = [",
    exported,
    "]",
    "",
  ].join("\n");
}

function writeGenerated(output: string, contents: string, kind: string): void {
  const destination = relative(root, output);
  if (values.check) {
    if (!existsSync(output) || readFileSync(output, "utf8") !== contents) {
      throw new Error(`Generated ${kind} is stale: ${destination}`);
    }
    console.log(`verified ${destination}`);
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  makeWritable(output);
  writeFileSync(output, contents);
  makeReadonly(output);
  console.log(`generated ${destination}`);
}
