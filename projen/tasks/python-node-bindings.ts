#!/usr/bin/env -S bun
/**
 * Generate a shared PythonMonkey runtime and typed Python wrappers from each
 * package's serialized node-binding configuration.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { log, stringUtils } from "@dbx-tools/shared-core";
import type { BunPlugin } from "bun";
import stdLibBrowser from "node-stdlib-browser";
import ts from "typescript";
import { header, makeReadonly, makeWritable } from "../src/generated.ts";
import { publicFunctionExports, publicNamespaceExports } from "../src/module-exports.ts";
import {
  PYTHON_NODE_SHIM_ROOT,
  resolvePythonNodeBindings,
  type ResolvedPythonNodeBindings,
  type ResolvedPythonNodeFunctionOverride,
} from "../src/python-node-bindings.ts";

const logger = log.logger("projen:python-node-bindings");

type FunctionOverride = ResolvedPythonNodeFunctionOverride;

function bindingIndex(value: string, count: number, project: string): number {
  const index = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(index) || String(index) !== value || index < 0 || index >= count) {
    throw new Error(`Node binding index ${value} is not configured for ${project}`);
  }
  return index;
}

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

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      binding: { type: "string" },
      check: { type: "boolean" },
      module: { type: "string" },
      project: { type: "string" },
      root: { type: "string" },
    },
  });
  if (!values.project) throw new Error("Expected --project <python-project-directory>");

  const root = values.root
    ? resolve(values.root)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const configs = resolvePythonNodeBindings(root, values.project).map(discoverBindingModules);
  if (configs.length > 1 && configs.some(({ modules }) => modules.length === 0)) {
    throw new Error(
      "Every Node binding must export a namespace with bindable functions or configure modules",
    );
  }
  const selectedBinding =
    values.binding === undefined
      ? undefined
      : bindingIndex(values.binding, configs.length, values.project);
  const config = selectedBinding === undefined ? configs[0] : configs[selectedBinding];
  if (!config) throw new Error("Expected at least one Node binding configuration");
  if (selectedBinding === undefined && (configs.length > 1 || config.modules.length > 0)) {
    prepareBindingDirectory(configs);
    writeRuntimeLoader(configs);
    for (const [binding, candidate] of configs.entries()) {
      for (const module of candidate.modules) {
        await main([
          "--project",
          values.project,
          ...(values.root ? ["--root", values.root] : []),
          ...(values.check ? ["--check"] : []),
          "--binding",
          String(binding),
          "--module",
          module,
        ]);
      }
    }
    return;
  }
  if (config.modules.length > 0 && !values.module) {
    throw new Error(`Expected --module for Node binding ${selectedBinding ?? 0}`);
  }
  const { bindingDirectory, projectDirectory, pyproject, runtimeOutput } = config;
  const selectedModule = values.module;
  if (selectedModule && !config.modules.includes(selectedModule)) {
    throw new Error(
      `Node binding module ${selectedModule} is not configured: ${config.modules.join(", ")}`,
    );
  }
  const bindingsOutput = join(
    bindingDirectory,
    `${selectedModule ? pythonFunctionName(selectedModule) : "index"}.py`,
  );
  const packageEntrypoint = Bun.resolveSync(config.entrypoint, projectDirectory);
  const entrypoint = selectedModule
    ? resolveGeneratedModule(packageEntrypoint, selectedModule)
    : packageEntrypoint;
  const functions = publicFunctionExports(entrypoint);
  if (functions.length === 0) {
    throw new Error(`${config.entrypoint} exports no plain functions that can be bound to Python`);
  }
  const functionTypes = pythonFunctionTypes(entrypoint, functions);
  applyOptionDefaults(functionTypes.records, await import(pathToFileURL(entrypoint).href));
  const pythonFunctions = functions.map(({ name, sourceFile, sourceName, async }) => ({
    javascriptName: name,
    pythonName: pythonFunctionName(name),
    async,
    ...(functionTypes.functions.get(`${sourceFile}#${sourceName}`) ?? {
      parameters: [],
      returnType: "Any",
    }),
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

  const shimRoot = PYTHON_NODE_SHIM_ROOT;
  const overridesByModule = groupOverrides(
    configs.flatMap(({ functionOverrides }) => functionOverrides),
  );
  const shimEntry = "dbx-tools:python-entry";
  const functionOverrideNamespace = "dbx-tools-function-override";
  const shimAliases = new Map([
    ["child_process", resolve(shimRoot, "child-process.ts")],
    ["crypto", resolve(shimRoot, "crypto.ts")],
    ["fs", resolve(shimRoot, "fs.ts")],
    ["fs/promises", resolve(shimRoot, "fs-promises.ts")],
    ["os", resolve(shimRoot, "os.ts")],
    ["process", resolve(shimRoot, "process.ts")],
    ["readline", resolve(shimRoot, "readline.ts")],
  ]);
  const bridgeSource = [
    "export const __pythonGet = (target, name) => target[name];",
    "export const __pythonInvokePositioned = (fn, entries) => {",
    "  const args = [];",
    "  for (const [index, value] of entries) args[index] = value;",
    "  return fn(...args);",
    "};",
    "export const __pythonKind = (value) => {",
    "  if (value === null) return 'null';",
    "  if (Array.isArray(value)) return 'array';",
    "  if (typeof value !== 'object') return typeof value;",
    "  const prototype = Object.getPrototypeOf(value);",
    "  return prototype === Object.prototype || prototype === null ? 'record' : 'instance';",
    "};",
    "export const __pythonInvokeMethod = async (target, name, args) => {",
    "  try {",
    "    const value = await Reflect.apply(target[name], target, args);",
    "    return { ok: true, value: value === undefined ? null : value };",
    "  } catch (error) {",
    "    return {",
    "      ok: false,",
    "      error: {",
    "        name: error instanceof Error ? error.name : 'Error',",
    "        message: error instanceof Error ? error.message : String(error),",
    "        stack: error instanceof Error ? error.stack : undefined,",
    "      },",
    "    };",
    "  }",
    "};",
  ].join("\n");
  const runtimeModules = configs.flatMap((binding) => {
    const entrypoint = Bun.resolveSync(binding.entrypoint, binding.projectDirectory);
    return binding.modules.length > 0
      ? binding.modules.map((module) => ({
          key: runtimeModuleName(binding, module),
          entrypoint: resolveGeneratedModule(entrypoint, module),
        }))
      : [{ key: runtimeModuleName(binding), entrypoint }];
  });
  const runtimeExports = [
    ...runtimeModules.map(
      ({ entrypoint }, index) =>
        `import * as __pythonModule${index} from ${JSON.stringify(entrypoint)};`,
    ),
    "const __pythonModules = {",
    ...runtimeModules.map(
      ({ key }, index) => `  ${JSON.stringify(key)}: () => __pythonModule${index},`,
    ),
    "};",
    "export const __pythonModule = (name) => {",
    "  const load = __pythonModules[name];",
    "  if (!load) throw new Error(`Unknown Python binding module: ${name}`);",
    "  return load();",
    "};",
  ];
  const standardAliases = stdLibBrowser as Record<string, string | undefined>;
  const runtimePlugin: BunPlugin = {
    name: "python-node-runtime",
    setup(build) {
      build.onResolve({ filter: /^dbx-tools:python-entry$/ }, () => ({
        path: shimEntry,
        namespace: "dbx-tools-python",
      }));
      build.onLoad({ filter: /.*/, namespace: "dbx-tools-python" }, () => ({
        contents: [
          `import ${JSON.stringify(resolve(shimRoot, "bootstrap.ts"))};`,
          bridgeSource,
          ...runtimeExports,
        ].join("\n"),
        loader: "ts",
      }));
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
        if (path === "zod") {
          return {
            path: resolve(dirname(Bun.resolveSync("zod/package.json", root)), "index.cjs"),
          };
        }
        if (overridesByModule.has(path)) {
          return { path, namespace: functionOverrideNamespace };
        }
        const moduleName = path.replace(/^node:/, "");
        const shim = shimAliases.get(moduleName) ?? shimAliases.get(path);
        if (shim) return { path: shim };
        const standard = standardAliases[moduleName];
        return standard
          ? { path: Bun.resolveSync(standard, dirname(fileURLToPath(import.meta.url))) }
          : undefined;
      });
    },
  };

  const runtimeSource = `${configs.map(({ entrypoint }) => entrypoint).join(", ")} configured by ${relative(root, pyproject)}`;
  const source = `${config.entrypoint}${selectedModule ? `#${selectedModule}` : ""} configured by ${relative(root, pyproject)}`;
  if (selectedBinding === undefined) {
    prepareBindingDirectory(configs);
    writeRuntimeLoader(configs);
  }
  await generate();

  function discoverBindingModules(
    candidate: ResolvedPythonNodeBindings,
  ): ResolvedPythonNodeBindings {
    if (candidate.modules.length > 0) return candidate;
    const packageEntrypoint = Bun.resolveSync(candidate.entrypoint, candidate.projectDirectory);
    const modules = publicNamespaceExports(packageEntrypoint).filter(
      (module) =>
        publicFunctionExports(resolveGeneratedModule(packageEntrypoint, module)).length > 0,
    );
    return { ...candidate, modules };
  }

  async function generate(): Promise<void> {
    const result = await Bun.build({
      entrypoints: [shimEntry],
      format: "cjs",
      plugins: [runtimePlugin],
      target: "browser",
    });
    if (!result.success) {
      for (const message of result.logs) logger.error(message);
      throw new Error(`Could not bundle ${config.entrypoint}`);
    }
    if (result.outputs.length !== 1) {
      throw new Error(`Expected one JavaScript bundle, received ${result.outputs.length}`);
    }

    const bundled = (await result.outputs[0].text()).replace(/[ \t]+$/gm, "");
    const runtime = `${header({
      tool: "projen/tasks/python-node-bindings.ts",
      source: runtimeSource,
    })}\n${bundled}`;
    const bindings = pythonBindings(
      source,
      pythonFunctions,
      functionTypes.records,
      functionTypes.responses,
      functionTypes.protocols,
      runtimeModuleName(config, selectedModule),
    );
    writeGenerated(runtimeOutput, runtime, "JavaScript runtime");
    writeGenerated(bindingsOutput, bindings, "Python bindings");
  }

  function prepareBindingDirectory(bindings: readonly ResolvedPythonNodeBindings[]): void {
    const moduleDirectory = bindings[0]?.moduleDirectory;
    if (!moduleDirectory) return;
    const nodeDirectory = join(moduleDirectory, "_generated", "node");
    const generatedPackage = join(moduleDirectory, "_generated", "__init__.py");
    if (values.check && existsSync(generatedPackage)) {
      throw new Error(
        `Generated Node bindings contain stale file ${relative(root, generatedPackage)}`,
      );
    }
    if (!values.check) rmSync(generatedPackage, { force: true });
    const expected = new Set(
      [
        bindings[0]?.runtimeOutput,
        moduleDirectory ? join(moduleDirectory, "_generated", "node", "_runtime.py") : undefined,
        ...bindings.flatMap((binding) => [
          ...(binding.modules.length > 0
            ? binding.modules.map((module) =>
                join(binding.bindingDirectory, `${pythonFunctionName(module)}.py`),
              )
            : [join(binding.bindingDirectory, "index.py")]),
        ]),
      ].filter((file): file is string => Boolean(file)),
    );
    const stale = generatedFiles(nodeDirectory).filter((file) => !expected.has(file));
    if (stale.length > 0) {
      if (values.check) {
        throw new Error(
          `Generated Node bindings contain stale files:\n${stale.map((file) => `  ${relative(root, file)}`).join("\n")}`,
        );
      }
      for (const file of stale) rmSync(file, { force: true });
      removeEmptyDirectories(nodeDirectory);
    }
  }

  function writeRuntimeLoader(bindings: readonly ResolvedPythonNodeBindings[]): void {
    const moduleDirectory = bindings[0]?.moduleDirectory;
    if (!moduleDirectory) return;
    writeGenerated(
      join(moduleDirectory, "_generated", "node", "_runtime.py"),
      pythonRuntimeLoader(
        `${bindings.map(({ entrypoint }) => entrypoint).join(", ")} configured by ${relative(root, bindings[0]!.pyproject)}`,
      ),
      "PythonMonkey runtime loader",
    );
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

  function runtimeModuleName(binding: ResolvedPythonNodeBindings, module?: string): string {
    return [binding.bindingName, ...(module ? [pythonFunctionName(module)] : [])].join("__");
  }

  function pythonBindings(
    source: string,
    functions: readonly PythonFunctionBinding[],
    records: readonly PythonRecord[],
    responses: readonly PythonResponse[],
    protocols: readonly PythonProtocol[],
    javascriptModule: string,
  ): string {
    const exported = [
      ...records.map(({ name }) => name),
      ...responses.map(({ name }) => name),
      ...protocols.map(({ name }) => name),
      ...functions.map(({ pythonName }) => pythonName),
    ]
      .sort()
      .map((name) => `    ${JSON.stringify(name)},`)
      .join("\n");
    const dataclasses = records.map(pythonDataclass).join("\n\n\n");
    const responseTypes = orderPythonResponses(responses).map(pythonResponse).join("\n\n\n");
    const protocolTypes = protocols.map(pythonProtocol).join("\n\n\n");
    const wrappers = functions
      .map(({ async, javascriptName, pythonName, parameters, returnType }) =>
        pythonWrapper(async, javascriptModule, javascriptName, pythonName, parameters, returnType),
      )
      .join("\n\n\n");
    const usesCallable = [dataclasses, responseTypes, protocolTypes, wrappers].some((section) =>
      section.includes("Callable["),
    );
    return [
      "# GENERATED by projen/tasks/python-node-bindings.ts - DO NOT EDIT.",
      `# Regenerated from ${source}.`,
      "# Hand edits are overwritten; this file is read-only.",
      "",
      "from __future__ import annotations",
      "",
      ...(usesCallable ? ["from collections.abc import Callable"] : []),
      "from dataclasses import dataclass, field",
      "from typing import Any, NotRequired, Protocol, TypedDict",
      "",
      "from .._runtime import MISSING as _MISSING",
      "from .._runtime import invoke_positioned as _invoke_positioned",
      "from .._runtime import invoke_positioned_sync as _invoke_positioned_sync",
      "",
      "",
      dataclasses,
      ...(dataclasses ? ["", ""] : []),
      responseTypes,
      ...(responseTypes ? ["", ""] : []),
      protocolTypes,
      ...(protocolTypes ? ["", ""] : []),
      wrappers,
      "",
      "",
      "__all__ = [",
      exported,
      "]",
      "",
    ].join("\n");
  }

  interface PythonFunctionBinding {
    readonly async: boolean;
    readonly javascriptName: string;
    readonly parameters: readonly PythonParameter[];
    readonly pythonName: string;
    readonly returnType: string;
  }

  interface PythonParameter {
    readonly javascriptName: string;
    readonly pythonName: string;
    readonly record?: string;
    readonly required: boolean;
    readonly type: string;
  }

  interface PythonRecord {
    readonly name: string;
    readonly fields: readonly PythonField[];
  }

  interface PythonField {
    readonly defaultValue?: unknown;
    readonly javascriptName: string;
    readonly pythonName: string;
    readonly type: string;
  }

  interface PythonResponse {
    readonly fields: readonly PythonResponseField[];
    readonly name: string;
  }

  interface PythonResponseField {
    readonly name: string;
    readonly required: boolean;
    readonly type: string;
  }

  /**
   * Emit nested response types before the responses that reference them.
   *
   * Functional TypedDict declarations evaluate their field types immediately,
   * unlike class annotations protected by `from __future__ import annotations`.
   */
  function orderPythonResponses(responses: readonly PythonResponse[]): PythonResponse[] {
    const ordered: PythonResponse[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (response: PythonResponse): void => {
      if (visited.has(response.name) || visiting.has(response.name)) return;
      visiting.add(response.name);
      for (const dependency of responses) {
        if (
          dependency.name !== response.name &&
          response.fields.some(({ type }) => new RegExp(`\\b${dependency.name}\\b`).test(type))
        ) {
          visit(dependency);
        }
      }
      visiting.delete(response.name);
      visited.add(response.name);
      ordered.push(response);
    };

    for (const response of responses) visit(response);
    return ordered;
  }

  interface PythonProtocol {
    readonly methods: readonly PythonProtocolMethod[];
    readonly name: string;
    readonly properties: readonly PythonProtocolProperty[];
  }

  interface PythonProtocolMethod {
    readonly name: string;
    readonly parameters: readonly PythonProtocolParameter[];
    readonly returnType: string;
  }

  interface PythonProtocolParameter {
    readonly name: string;
    readonly required: boolean;
    readonly type: string;
  }

  interface PythonProtocolProperty {
    readonly name: string;
    readonly required: boolean;
    readonly type: string;
  }

  interface PythonFunctionType {
    readonly parameters: readonly PythonParameter[];
    readonly returnType: string;
  }

  function pythonFunctionTypes(
    entrypoint: string,
    functions: readonly { sourceFile: string; sourceName: string }[],
  ): {
    functions: Map<string, PythonFunctionType>;
    protocols: PythonProtocol[];
    records: PythonRecord[];
    responses: PythonResponse[];
  } {
    const program = ts.createProgram({
      rootNames: [entrypoint],
      options: {
        allowImportingTsExtensions: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        strictNullChecks: true,
        target: ts.ScriptTarget.ESNext,
      },
    });
    const checker = program.getTypeChecker();
    const records = new Map<string, PythonRecord>();
    const responses = new Map<string, PythonResponse>();
    const protocols = new Map<string, PythonProtocol>();
    const typesByFunction = new Map<string, PythonFunctionType>();
    for (const exported of functions) {
      const sourceFile = program.getSourceFile(exported.sourceFile);
      if (!sourceFile) throw new Error(`TypeScript did not load ${exported.sourceFile}`);
      const declaration = findFunction(sourceFile, exported.sourceName);
      const parameters = declaration.parameters.map((parameter) => {
        if (!ts.isIdentifier(parameter.name)) {
          throw new Error(`${exported.sourceName} uses an unsupported destructured parameter`);
        }
        const parameterType = withoutUndefined(checker.getTypeAtLocation(parameter));
        const path = `${exported.sourceName}.${parameter.name.text}`;
        const record = pythonRecordType(
          checker,
          parameterType,
          records,
          path,
          declaredTypeName(parameter.type),
        );
        const required = !parameter.questionToken && !parameter.initializer;
        return {
          javascriptName: parameter.name.text,
          pythonName: pythonFunctionName(parameter.name.text),
          type: record?.name ?? pythonType(checker, parameterType, records, path),
          ...(record ? { record: record.name } : {}),
          required,
        };
      });
      const signature = checker.getSignatureFromDeclaration(declaration);
      if (!signature) throw new Error(`Could not resolve signature for ${exported.sourceName}`);
      const returnType = pythonReturnType(
        checker,
        declaration.type
          ? checker.getTypeFromTypeNode(declaration.type)
          : signature.getReturnType(),
        responses,
        protocols,
        `${exported.sourceName}.return`,
        declaredTypeName(declaration.type),
      );
      typesByFunction.set(`${exported.sourceFile}#${exported.sourceName}`, {
        parameters,
        returnType,
      });
    }
    return {
      functions: typesByFunction,
      protocols: [...protocols.values()].sort((left, right) => left.name.localeCompare(right.name)),
      records: [...records.values()].sort((left, right) => left.name.localeCompare(right.name)),
      responses: [...responses.values()].sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
      else ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`Could not find function ${name} in ${source.fileName}`);
    return found;
  }

  function pythonRecord(
    checker: ts.TypeChecker,
    type: ts.Type,
    records: Map<string, PythonRecord>,
    path: string,
    preferredName?: string,
  ): PythonRecord {
    const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    const name = symbolName && symbolName !== "__type" ? symbolName : preferredName;
    if (!name || name === "__type") throw new Error(`${path} must reference a named object type`);
    const existing = records.get(name);
    if (existing) return existing;
    const placeholder: PythonRecord = { name, fields: [] };
    records.set(name, placeholder);
    const fields = checker.getPropertiesOfType(type).map((property) => {
      const propertyType = withoutUndefined(
        resolvedPropertyType(checker, type, property, `${path}.${property.name}`),
      );
      return {
        javascriptName: property.name,
        pythonName: pythonFunctionName(property.name),
        type: pythonType(checker, propertyType, records, `${path}.${property.name}`),
      };
    });
    const record = { name, fields };
    records.set(name, record);
    return record;
  }

  function pythonRecordType(
    checker: ts.TypeChecker,
    type: ts.Type,
    records: Map<string, PythonRecord>,
    path: string,
    preferredName?: string,
  ): PythonRecord | undefined {
    if (!(type.flags & ts.TypeFlags.Object)) return undefined;
    if (checker.isArrayType(type) || type.getCallSignatures().length > 0) return undefined;
    if (checker.getIndexTypeOfType(type, ts.IndexKind.String)) return undefined;
    const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    const name = symbolName && symbolName !== "__type" ? symbolName : preferredName;
    if (!name || name === "__type") return undefined;
    return pythonRecord(checker, type, records, path, preferredName);
  }

  function declaredTypeName(node: ts.TypeNode | undefined): string | undefined {
    if (!node) return undefined;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      return node.typeName.text;
    }
    return undefined;
  }

  function pythonType(
    checker: ts.TypeChecker,
    type: ts.Type,
    records: Map<string, PythonRecord>,
    path: string,
  ): string {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "Any";
    if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
      return "None";
    }
    if (type.flags & ts.TypeFlags.StringLike) return "str";
    if (type.flags & ts.TypeFlags.NumberLike) return "int | float";
    if (type.flags & ts.TypeFlags.BooleanLike) return "bool";
    if (type.isUnion()) {
      const mapped = type.types
        .filter((item) => !(item.flags & ts.TypeFlags.Undefined))
        .map((item) => pythonType(checker, item, records, path));
      return pythonUnion(mapped);
    }
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      if (!element) throw new Error(`${path} array element type could not be resolved`);
      return `list[${pythonType(checker, withoutUndefined(element), records, `${path}[]`)}]`;
    }
    if (type.getCallSignatures().length > 0) {
      return "Callable[..., Any]";
    }
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      return `dict[str, ${pythonType(checker, withoutUndefined(stringIndex), records, `${path}{}`)}]`;
    }
    const record = pythonRecordType(checker, type, records, path);
    if (record) return record.name;
    throw new Error(`${path} uses unsupported TypeScript type ${checker.typeToString(type)}`);
  }

  function pythonReturnType(
    checker: ts.TypeChecker,
    type: ts.Type,
    responses: Map<string, PythonResponse>,
    protocols: Map<string, PythonProtocol>,
    path: string,
    preferredName?: string,
  ): string {
    if (type.isUnion()) {
      return pythonUnion(
        type.types.map((item) => pythonReturnType(checker, item, responses, protocols, path)),
      );
    }
    const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    const targetName = (type as ts.TypeReference).target?.getSymbol()?.getName();
    if ([symbolName, targetName].some((name) => ["Promise", "PromiseLike"].includes(name ?? ""))) {
      const [resolved] = checker.getTypeArguments(type as ts.TypeReference);
      if (!resolved) throw new Error(`${path} promise type could not be resolved`);
      return pythonReturnType(checker, resolved, responses, protocols, path);
    }
    const awaited = checker.getAwaitedType(type) ?? type;
    if (awaited !== type) return pythonReturnType(checker, awaited, responses, protocols, path);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "Any";
    if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
      return "None";
    }
    if (type.flags & ts.TypeFlags.StringLike) return "str";
    if (type.flags & ts.TypeFlags.NumberLike) return "int | float";
    if (type.flags & ts.TypeFlags.BooleanLike) return "bool";
    if (checker.isArrayType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      if (!element) throw new Error(`${path} array element type could not be resolved`);
      return `list[${pythonReturnType(checker, element, responses, protocols, `${path}[]`)}]`;
    }
    if ([symbolName, targetName].some((name) => ["Map", "ReadonlyMap"].includes(name ?? ""))) {
      const [key, value] = checker.getTypeArguments(type as ts.TypeReference);
      if (!key || !value) throw new Error(`${path} map types could not be resolved`);
      return `dict[${pythonReturnType(checker, key, responses, protocols, `${path}.key`)}, ${pythonReturnType(checker, value, responses, protocols, `${path}.value`)}]`;
    }
    if (type.getCallSignatures().length > 0) return "Callable[..., Any]";
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      return `dict[str, ${pythonReturnType(checker, stringIndex, responses, protocols, `${path}{}`)}]`;
    }
    if (!(type.flags & ts.TypeFlags.Object)) {
      throw new Error(
        `${path} uses unsupported TypeScript return type ${checker.typeToString(type)}`,
      );
    }
    const properties = checker.getPropertiesOfType(type).filter(publicProperty);
    const methods = properties.filter(
      (property) =>
        resolvedPropertyType(
          checker,
          type,
          property,
          `${path}.${property.name}`,
        ).getCallSignatures().length > 0,
    );
    if (methods.length > 0) {
      const name = pythonObjectName(type, path, "Result");
      if (protocols.has(name)) return name;
      protocols.set(name, { name, methods: [], properties: [] });
      const protocolMethods = methods.map((property) => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        if (!declaration) throw new Error(`${path}.${property.name} has no TypeScript declaration`);
        const signatures = checker
          .getTypeOfSymbolAtLocation(property, declaration)
          .getCallSignatures();
        if (signatures.length !== 1) {
          throw new Error(`${path}.${property.name} must have exactly one call signature`);
        }
        const signature = signatures[0];
        const parameters = signature.getParameters().map((parameter) => {
          const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
          if (!parameterDeclaration) {
            throw new Error(`${path}.${property.name}.${parameter.name} has no declaration`);
          }
          const parameterType = withoutUndefined(
            checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
          );
          return {
            name: pythonFunctionName(parameter.name),
            required:
              !(parameter.flags & ts.SymbolFlags.Optional) &&
              (!ts.isParameter(parameterDeclaration) ||
                (!parameterDeclaration.questionToken && !parameterDeclaration.initializer)),
            type: pythonParameterReturnType(
              checker,
              parameterType,
              responses,
              protocols,
              `${path}.${property.name}.${parameter.name}`,
            ),
          };
        });
        const methodDeclaration = property.declarations?.find(
          (candidate) => ts.isMethodDeclaration(candidate) || ts.isMethodSignature(candidate),
        );
        return {
          name: pythonFunctionName(property.name),
          parameters,
          returnType: pythonReturnType(
            checker,
            methodDeclaration?.type
              ? checker.getTypeFromTypeNode(methodDeclaration.type)
              : signature.getReturnType(),
            responses,
            protocols,
            `${path}.${property.name}.return`,
          ),
        };
      });
      const methodNames = new Set(methods.map(({ name }) => name));
      const protocolProperties = properties
        .filter(({ name }) => !methodNames.has(name))
        .map((property) => {
          return {
            name: pythonFunctionName(property.name),
            required: !(property.flags & ts.SymbolFlags.Optional),
            type: pythonReturnType(
              checker,
              withoutUndefined(
                resolvedPropertyType(checker, type, property, `${path}.${property.name}`),
              ),
              responses,
              protocols,
              `${path}.${property.name}`,
            ),
          };
        });
      protocols.set(name, { name, methods: protocolMethods, properties: protocolProperties });
      return name;
    }
    const name = `${preferredName ?? pythonObjectName(type, path, "Result")}Response`;
    if (responses.has(name)) return name;
    responses.set(name, { name, fields: [] });
    const fields = properties.map((property) => {
      return {
        name: property.name,
        required: !(property.flags & ts.SymbolFlags.Optional),
        type: pythonReturnType(
          checker,
          withoutUndefined(
            resolvedPropertyType(checker, type, property, `${path}.${property.name}`),
          ),
          responses,
          protocols,
          `${path}.${property.name}`,
        ),
      };
    });
    responses.set(name, { name, fields });
    return name;
  }

  function pythonParameterReturnType(
    checker: ts.TypeChecker,
    type: ts.Type,
    responses: Map<string, PythonResponse>,
    protocols: Map<string, PythonProtocol>,
    path: string,
  ): string {
    if (!type.isUnion()) return pythonReturnType(checker, type, responses, protocols, path);
    return pythonUnion(
      type.types
        .filter((item) => !(item.flags & ts.TypeFlags.Undefined))
        .map((item) => pythonReturnType(checker, item, responses, protocols, path)),
    );
  }

  function pythonUnion(types: readonly string[]): string {
    return [...new Set(types)]
      .sort((left, right) => (left === "None" ? 1 : right === "None" ? -1 : 0))
      .join(" | ");
  }

  function publicProperty(property: ts.Symbol): boolean {
    if (!property.declarations?.length) return true;
    return (property.declarations ?? []).some((declaration) => {
      const flags = ts.getCombinedModifierFlags(declaration as ts.Declaration);
      return !(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
    });
  }

  function resolvedPropertyType(
    checker: ts.TypeChecker,
    owner: ts.Type,
    property: ts.Symbol,
    path: string,
  ): ts.Type {
    const location =
      property.valueDeclaration ??
      property.declarations?.[0] ??
      owner.aliasSymbol?.declarations?.[0] ??
      owner.getSymbol()?.declarations?.[0];
    if (!location) throw new Error(`${path} has no TypeScript type location`);
    return checker.getTypeOfSymbolAtLocation(property, location);
  }

  function pythonObjectName(type: ts.Type, path: string, suffix: string): string {
    const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    if (name && name !== "__type") return name;
    const identifier = stringUtils.toIdentifierWithOptions({ delimiter: "_" }, path);
    return `${identifier
      .split("_")
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join("")}${suffix}`;
  }

  function withoutUndefined(type: ts.Type): ts.Type {
    if (!type.isUnion()) return type;
    const retained = type.types.filter((candidate) => !(candidate.flags & ts.TypeFlags.Undefined));
    if (retained.length !== 1) return type;
    return retained[0];
  }

  function pythonDataclass(record: PythonRecord): string {
    const body = record.fields.length
      ? record.fields
          .map((field) => {
            const defaultArgument = Object.hasOwn(field, "defaultValue")
              ? pythonDefault(field.defaultValue)
              : "default=None";
            return [
              `    ${field.pythonName}: ${pythonOptionalType(field.type)} = field(`,
              `        ${defaultArgument},`,
              `        metadata={"javascript_name": ${JSON.stringify(field.javascriptName)}},`,
              "    )",
            ].join("\n");
          })
          .join("\n")
      : "    pass";
    return `@dataclass(kw_only=True)\nclass ${record.name}:\n${body}`;
  }

  function pythonOptionalType(type: string): string {
    return type.split(" | ").includes("None") ? type : `${type} | None`;
  }

  function pythonResponse(response: PythonResponse): string {
    if (response.fields.some(({ name }) => !isPythonIdentifier(name))) {
      const fields = response.fields
        .map(
          ({ name, required, type }) =>
            `        ${JSON.stringify(name)}: ${required ? type : `NotRequired[${type}]`},`,
        )
        .join("\n");
      return [
        `${response.name} = TypedDict(`,
        `    ${JSON.stringify(response.name)},`,
        "    {",
        fields,
        "    },",
        ")",
      ].join("\n");
    }
    const body = response.fields.length
      ? response.fields
          .map(
            ({ name, required, type }) =>
              `    ${name}: ${required ? type : `NotRequired[${type}]`}`,
          )
          .join("\n")
      : "    pass";
    return `class ${response.name}(TypedDict):\n${body}`;
  }

  function isPythonIdentifier(value: string): boolean {
    return /^[_A-Za-z]\w*$/.test(value) && !PYTHON_KEYWORDS.has(value);
  }

  function pythonProtocol(protocol: PythonProtocol): string {
    const properties = protocol.properties.map(
      ({ name, required, type }) => `    ${name}: ${required ? type : pythonOptionalType(type)}`,
    );
    const methods = protocol.methods.length
      ? protocol.methods
          .map((method) => {
            const parameters = method.parameters.map(
              ({ name, required, type }) => `        ${name}: ${type}${required ? "" : " = ..."},`,
            );
            return [
              `    async def ${method.name}(`,
              "        self,",
              ...parameters,
              `    ) -> ${method.returnType}: ...`,
            ].join("\n");
          })
          .join("\n\n")
      : "";
    const body = [...properties, methods].filter(Boolean).join("\n\n") || "    pass";
    return `class ${protocol.name}(Protocol):\n${body}`;
  }

  function applyOptionDefaults(
    records: readonly PythonRecord[],
    runtime: Record<string, unknown>,
  ): void {
    for (const record of records) {
      const companion = runtime[record.name] as { defaults?: () => unknown } | undefined;
      if (typeof companion?.defaults !== "function") continue;
      const defaults = companion.defaults();
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
        throw new Error(`${record.name}.defaults() must return a record`);
      }
      const values = defaults as Record<string, unknown>;
      const fields = record.fields.map((field) =>
        Object.hasOwn(values, field.javascriptName)
          ? { ...field, defaultValue: values[field.javascriptName] }
          : field,
      );
      (record as { fields: readonly PythonField[] }).fields = fields;
    }
  }

  function pythonDefault(value: unknown): string {
    if (value === undefined) return "default=None";
    if (value === null) return "default=None";
    if (typeof value === "boolean") return `default=${value ? "True" : "False"}`;
    if (typeof value === "number" && Number.isFinite(value)) return `default=${value}`;
    if (typeof value === "string") return `default=${JSON.stringify(value)}`;
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
      return `default_factory=lambda: ${pythonLiteral(value)}`;
    }
    throw new Error(`Unsupported defaults() value: ${String(value)}`);
  }

  function pythonLiteral(value: unknown): string {
    if (value === null) return "None";
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
    if (typeof value === "object") {
      return `{${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`)
        .join(", ")}}`;
    }
    throw new Error(`Unsupported defaults() value: ${String(value)}`);
  }

  function pythonWrapper(
    asyncFunction: boolean,
    javascriptModule: string,
    javascriptName: string,
    pythonName: string,
    parameters: readonly PythonParameter[],
    returnType: string,
  ): string {
    const definition = asyncFunction ? "async def" : "def";
    const invoke = asyncFunction
      ? `await _invoke_positioned(${JSON.stringify(javascriptModule)}, ${JSON.stringify(javascriptName)}, arguments)`
      : `_invoke_positioned_sync(${JSON.stringify(javascriptModule)}, ${JSON.stringify(javascriptName)}, arguments)`;
    if (parameters.length === 0) {
      return `${definition} ${pythonName}() -> ${returnType}:\n    arguments: list[tuple[int, Any]] = []\n    return ${invoke}`;
    }
    const signature = parameters.map((parameter) => {
      const type = parameter.record
        ? `${parameter.record} | dict[str, Any] | None`
        : parameter.type;
      return `    ${parameter.pythonName}: ${type}${parameter.required ? "" : " | object = _MISSING"},`;
    });
    const body = ["    arguments: list[tuple[int, Any]] = []"];
    for (const [index, parameter] of parameters.entries()) {
      if (parameter.required) {
        body.push(`    arguments.append((${index}, ${parameter.pythonName}))`);
      } else {
        body.push(
          `    if ${parameter.pythonName} is not _MISSING:`,
          `        arguments.append((${index}, ${parameter.pythonName}))`,
        );
      }
    }
    body.push(`    return ${invoke}`);
    return [`${definition} ${pythonName}(`, ...signature, `) -> ${returnType}:`, ...body].join(
      "\n",
    );
  }

  function writeGenerated(output: string, contents: string, kind: string): void {
    const destination = relative(root, output);
    if (existsSync(output) && readFileSync(output, "utf8") === contents) {
      if (values.check) logger.info(`verified ${destination}`);
      return;
    }
    if (values.check) {
      throw new Error(`Generated ${kind} is stale: ${destination}`);
    }
    mkdirSync(dirname(output), { recursive: true });
    makeWritable(output);
    writeFileSync(output, contents);
    makeReadonly(output);
    logger.info(`generated ${destination}`);
  }
}

function generatedFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? generatedFiles(path) : [path];
  });
}

function removeEmptyDirectories(directory: string): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(directory, entry.name));
  }
  if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
}

function pythonRuntimeLoader(source: string): string {
  return [
    "# GENERATED by projen/tasks/python-node-bindings.ts - DO NOT EDIT.",
    `# Regenerated from ${source}.`,
    "# Hand edits are overwritten; this file is read-only.",
    "",
    "from __future__ import annotations",
    "",
    "import asyncio",
    "import inspect",
    "from dataclasses import fields, is_dataclass",
    "from pathlib import Path",
    "from threading import Lock",
    "from typing import Any",
    "",
    "import pythonmonkey as pm",
    "import pythonmonkey.require",
    "",
    "_RUNTIME: Any | None = None",
    "_LOCK = Lock()",
    "MISSING = object()",
    "",
    "",
    "def _load_runtime() -> Any:",
    "    try:",
    "        asyncio.get_running_loop()",
    "    except RuntimeError:",
    "        async def load() -> Any:",
    '            return pm.require(str(Path(__file__).with_name("_runtime.js")))',
    "",
    "        return asyncio.run(load())",
    '    return pm.require(str(Path(__file__).with_name("_runtime.js")))',
    "",
    "",
    "def get_runtime() -> Any:",
    "    global _RUNTIME",
    "    if _RUNTIME is None:",
    "        with _LOCK:",
    "            if _RUNTIME is None:",
    "                _RUNTIME = _load_runtime()",
    "    return _RUNTIME",
    "",
    "",
    "def _module(name: str) -> Any:",
    '    return get_runtime()["__pythonModule"](name)',
    "",
    "",
    "def _snake_to_camel(name: str) -> str:",
    '    head, *tail = name.split("_")',
    '    return head + "".join(part[:1].upper() + part[1:] for part in tail)',
    "",
    "",
    "def _to_javascript(value: Any) -> Any:",
    "    if isinstance(value, _NodeObject):",
    "        return value._target",
    "    if is_dataclass(value) and not isinstance(value, type):",
    "        return {",
    '            item.metadata.get("javascript_name", item.name): _to_javascript(field_value)',
    "            for item in fields(value)",
    "            if (field_value := getattr(value, item.name)) is not None",
    "        }",
    "    if isinstance(value, dict):",
    "        return {key: _to_javascript(item) for key, item in value.items()}",
    "    if isinstance(value, (list, tuple)):",
    "        return [_to_javascript(item) for item in value]",
    "    return value",
    "",
    "",
    "def _from_javascript(value: Any) -> Any:",
    "    if isinstance(value, str):",
    '        return value.encode("utf-8").decode("utf-8")',
    "    if value is None or isinstance(value, (int, float, bool)):",
    "        return value",
    '    kind = get_runtime()["__pythonKind"](value)',
    '    if kind == "instance":',
    "        return _NodeObject(value)",
    '    if kind == "array":',
    "        return [_from_javascript(item) for item in value]",
    '    if kind == "record":',
    "        return {str(key): _from_javascript(item) for key, item in value.items()}",
    "    return value",
    "",
    "",
    "async def _resolve(value: Any) -> Any:",
    "    if inspect.isawaitable(value):",
    "        value = await value",
    "    return _from_javascript(value)",
    "",
    "",
    "class _NodeObject:",
    "    def __init__(self, target: Any) -> None:",
    "        self._target = target",
    "",
    "    def __getattr__(self, name: str) -> Any:",
    "        javascript_name = _snake_to_camel(name)",
    '        value = get_runtime()["__pythonGet"](self._target, javascript_name)',
    "        if not callable(value):",
    "            return _from_javascript(value)",
    "",
    "        async def invoke(*args: Any) -> Any:",
    '            result = await get_runtime()["__pythonInvokeMethod"](',
    "                self._target,",
    "                javascript_name,",
    "                [_to_javascript(arg) for arg in args],",
    "            )",
    '            if result["ok"]:',
    '                return _from_javascript(result["value"])',
    '            error = result["error"]',
    "            message = f\"{error['name']}: {error['message']}\"",
    '            if error.get("stack"):',
    "                message = f\"{message}\\n{error['stack']}\"",
    "            raise RuntimeError(message)",
    "",
    "        return invoke",
    "",
    "",
    "async def invoke_positioned(",
    "    module: str,",
    "    name: str,",
    "    arguments: list[tuple[int, Any]],",
    ") -> Any:",
    "    return await _resolve(",
    '        get_runtime()["__pythonInvokePositioned"](',
    "            _module(module)[name],",
    "            [[index, _to_javascript(value)] for index, value in arguments],",
    "        ),",
    "    )",
    "",
    "",
    "def invoke_positioned_sync(",
    "    module: str,",
    "    name: str,",
    "    arguments: list[tuple[int, Any]],",
    ") -> Any:",
    "    return _from_javascript(",
    '        get_runtime()["__pythonInvokePositioned"](',
    "            _module(module)[name],",
    "            [[index, _to_javascript(value)] for index, value in arguments],",
    "        ),",
    "    )",
    "",
  ].join("\n");
}

function resolveGeneratedModule(entrypoint: string, module: string): string {
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

if (import.meta.main) await main();
