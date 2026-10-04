#!/usr/bin/env -S bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { stringUtils } from "@dbx-tools/shared-core";
import type { BunPlugin } from "bun";
import stdLibBrowser from "node-stdlib-browser";
import ts from "typescript";
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
const { bindingsOutput, bindingsPackageOutput, projectDirectory, pyproject, runtimeOutput } =
  config;
const entrypoint = Bun.resolveSync(config.entrypoint, projectDirectory);
const functions = publicFunctionExports(entrypoint);
if (functions.length === 0) {
  throw new Error(`${config.entrypoint} exports no plain functions that can be bound to Python`);
}
const functionTypes = pythonFunctionTypes(entrypoint, functions);
applyOptionDefaults(functionTypes.records, await import(pathToFileURL(entrypoint).href));
const pythonFunctions = functions.map(({ name, sourceFile, sourceName }) => ({
  javascriptName: name,
  pythonName: pythonFunctionName(name),
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

const source = `${config.entrypoint} configured by ${relative(root, pyproject)}`;
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
    throw new Error(`Could not bundle ${config.entrypoint}`);
  }
  if (result.outputs.length !== 1) {
    throw new Error(`Expected one JavaScript bundle, received ${result.outputs.length}`);
  }

  const runtime = `${header({
    tool: "projen/tasks/python-node-bindings.ts",
    source,
  })}\n${await result.outputs[0].text()}`;
  const bindings = pythonBindings(
    source,
    pythonFunctions,
    functionTypes.records,
    functionTypes.responses,
    functionTypes.protocols,
  );
  const bindingsPackage = pythonBindingsPackage(
    source,
    pythonFunctions,
    functionTypes.records,
    functionTypes.responses,
    functionTypes.protocols,
    config.private,
  );
  writeGenerated(runtimeOutput, runtime, "JavaScript runtime");
  writeGenerated(bindingsOutput, bindings, "Python bindings");
  writeGenerated(bindingsPackageOutput, bindingsPackage, "Python bindings package");
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
  functions: readonly PythonFunctionBinding[],
  records: readonly PythonRecord[],
  responses: readonly PythonResponse[],
  protocols: readonly PythonProtocol[],
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
  const responseTypes = responses.map(pythonResponse).join("\n\n\n");
  const protocolTypes = protocols.map(pythonProtocol).join("\n\n\n");
  const wrappers = functions
    .map(({ javascriptName, pythonName, parameters, returnType }) =>
      pythonWrapper(javascriptName, pythonName, parameters, returnType),
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
    "import json",
    "from collections.abc import Callable",
    "from dataclasses import dataclass, field, fields, is_dataclass",
    "from pathlib import Path",
    "from typing import Any, NotRequired, Protocol, TypedDict",
    "",
    "import pythonmonkey as pm",
    "import pythonmonkey.require",
    "",
    '_GET = pm.eval("(target, name) => target[name]")',
    '_INVOKE = pm.eval("(target, name, args) => Reflect.apply(target[name], target, args)")',
    "_INVOKE_POSITIONED = pm.eval(",
    '    "(fn, entries) => { const args = []; for (const [index, value] of entries) args[index] = value; return fn(...args); }"',
    ")",
    "_KIND = pm.eval(",
    '    "(value) => {"',
    "    \" if (value === null) return 'null';\"",
    "    \" if (Array.isArray(value)) return 'array';\"",
    "    \" if (typeof value !== 'object') return typeof value;\"",
    '    " const prototype = Object.getPrototypeOf(value);"',
    "    \" return prototype === Object.prototype || prototype === null ? 'record' : 'instance';\"",
    '    " }"',
    ")",
    "_INVOKE_METHOD = pm.eval(",
    '    "async (target, name, args) => {"',
    '    " try {"',
    '    "  const value = await Reflect.apply(target[name], target, args);"',
    '    "  return JSON.stringify({ ok: true, value: value === undefined ? null : value });"',
    '    " } catch (error) {"',
    '    "  return JSON.stringify({"',
    '    "   ok: false,"',
    '    "   error: {"',
    "    \"    name: error instanceof Error ? error.name : 'Error',\"",
    '    "    message: error instanceof Error ? error.message : String(error),"',
    '    "    stack: error instanceof Error ? error.stack : undefined,"',
    '    "   },"',
    '    "  });"',
    '    " }"',
    '    " }"',
    ")",
    "_RUNTIME: Any | None = None",
    "_MISSING = object()",
    "",
    "",
    "def _runtime() -> Any:",
    "    global _RUNTIME",
    "    if _RUNTIME is None:",
    '        _RUNTIME = pm.require(str(Path(__file__).with_name("_runtime.js")))',
    "    return _RUNTIME",
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
    "    if value is None or isinstance(value, (str, int, float, bool)):",
    "        return value",
    "    kind = _KIND(value)",
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
    "        value = _GET(self._target, javascript_name)",
    "        if not callable(value):",
    "            return _from_javascript(value)",
    "",
    "        async def invoke(*args: Any) -> Any:",
    "            encoded = await _INVOKE_METHOD(",
    "                self._target,",
    "                javascript_name,",
    "                [_to_javascript(arg) for arg in args],",
    "            )",
    "            result = json.loads(encoded)",
    '            if result["ok"]:',
    '                return result["value"]',
    '            error = result["error"]',
    "            message = f\"{error['name']}: {error['message']}\"",
    '            if error.get("stack"):',
    "                message = f\"{message}\\n{error['stack']}\"",
    "            raise RuntimeError(message)",
    "",
    "        return invoke",
    "",
    "",
    "async def _invoke(name: str, *args: Any) -> Any:",
    "    return await _resolve(_runtime()[name](*[_to_javascript(arg) for arg in args]))",
    "",
    "",
    "async def _invoke_positioned(name: str, arguments: list[tuple[int, Any]]) -> Any:",
    "    return await _resolve(",
    "        _INVOKE_POSITIONED(",
    "            _runtime()[name],",
    "            [[index, _to_javascript(value)] for index, value in arguments],",
    "        ),",
    "    )",
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

function pythonBindingsPackage(
  source: string,
  functions: readonly { pythonName: string }[],
  records: readonly PythonRecord[],
  responses: readonly PythonResponse[],
  protocols: readonly PythonProtocol[],
  privateBindings: boolean,
): string {
  const names = [
    ...records.map(({ name }) => name),
    ...responses.map(({ name }) => name),
    ...protocols.map(({ name }) => name),
    ...functions.map(({ pythonName }) => pythonName),
  ].sort();
  const imported = names.map((name) => `    ${name},`).join("\n");
  const exported = names.map((name) => `    ${JSON.stringify(name)},`).join("\n");
  return [
    "# GENERATED by projen/tasks/python-node-bindings.ts - DO NOT EDIT.",
    `# Regenerated from ${source}.`,
    "# Hand edits are overwritten; this file is read-only.",
    "",
    ...(privateBindings ? [] : ["from .node_bindings import (", imported, ")", ""]),
    ...(privateBindings ? ["__all__ = []"] : ["__all__ = [", exported, "]"]),
    "",
  ].join("\n");
}

interface PythonFunctionBinding {
  readonly javascriptName: string;
  readonly parameters: readonly PythonParameter[];
  readonly pythonName: string;
  readonly returnType: string;
}

interface PythonParameter {
  readonly flatten: boolean;
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

interface PythonProtocol {
  readonly methods: readonly PythonProtocolMethod[];
  readonly name: string;
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
    const parameters = declaration.parameters.map((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) {
        throw new Error(`${exported.sourceName} uses an unsupported destructured parameter`);
      }
      const parameterType = withoutUndefined(checker.getTypeAtLocation(parameter));
      const path = `${exported.sourceName}.${parameter.name.text}`;
      const record = pythonRecordType(checker, parameterType, records, path);
      const required = !parameter.questionToken && !parameter.initializer;
      return {
        javascriptName: parameter.name.text,
        pythonName: pythonFunctionName(parameter.name.text),
        type: record?.name ?? pythonType(checker, parameterType, records, path),
        ...(record ? { record: record.name } : {}),
        required,
        flatten: index === declaration.parameters.length - 1 && !required && Boolean(record),
      };
    });
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (!signature) throw new Error(`Could not resolve signature for ${exported.sourceName}`);
    const returnType = pythonReturnType(
      checker,
      declaration.type ? checker.getTypeFromTypeNode(declaration.type) : signature.getReturnType(),
      responses,
      protocols,
      `${exported.sourceName}.return`,
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
): PythonRecord {
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (!name || name === "__type") throw new Error(`${path} must reference a named object type`);
  const existing = records.get(name);
  if (existing) return existing;
  const placeholder: PythonRecord = { name, fields: [] };
  records.set(name, placeholder);
  const fields = checker.getPropertiesOfType(type).map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) throw new Error(`${path}.${property.name} has no TypeScript declaration`);
    const propertyType = withoutUndefined(checker.getTypeOfSymbolAtLocation(property, declaration));
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
): PythonRecord | undefined {
  if (!(type.flags & ts.TypeFlags.Object)) return undefined;
  if (checker.isArrayType(type) || type.getCallSignatures().length > 0) return undefined;
  if (checker.getIndexTypeOfType(type, ts.IndexKind.String)) return undefined;
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (!name || name === "__type") return undefined;
  return pythonRecord(checker, type, records, path);
}

function pythonType(
  checker: ts.TypeChecker,
  type: ts.Type,
  records: Map<string, PythonRecord>,
  path: string,
): string {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "Any";
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return "None";
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
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return "None";
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
  const methods = properties.filter((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return Boolean(
      declaration &&
      checker.getTypeOfSymbolAtLocation(property, declaration).getCallSignatures().length,
    );
  });
  if (methods.length > 0) {
    const name = pythonObjectName(type, path, "Result");
    if (protocols.has(name)) return name;
    protocols.set(name, { name, methods: [] });
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
    protocols.set(name, { name, methods: protocolMethods });
    return name;
  }
  const name = `${pythonObjectName(type, path, "Result")}Response`;
  if (responses.has(name)) return name;
  responses.set(name, { name, fields: [] });
  const fields = properties.map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) throw new Error(`${path}.${property.name} has no TypeScript declaration`);
    return {
      name: property.name,
      required: !(property.flags & ts.SymbolFlags.Optional),
      type: pythonReturnType(
        checker,
        withoutUndefined(checker.getTypeOfSymbolAtLocation(property, declaration)),
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
  return (property.declarations ?? []).some((declaration) => {
    const flags = ts.getCombinedModifierFlags(declaration as ts.Declaration);
    return !(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
  });
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
          ({ name, required, type }) => `    ${name}: ${required ? type : `NotRequired[${type}]`}`,
        )
        .join("\n")
    : "    pass";
  return `class ${response.name}(TypedDict):\n${body}`;
}

function isPythonIdentifier(value: string): boolean {
  return /^[_A-Za-z]\w*$/.test(value) && !PYTHON_KEYWORDS.has(value);
}

function pythonProtocol(protocol: PythonProtocol): string {
  const body = protocol.methods.length
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
    : "    pass";
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
  javascriptName: string,
  pythonName: string,
  parameters: readonly PythonParameter[],
  returnType: string,
): string {
  if (parameters.length === 0) {
    return `async def ${pythonName}() -> ${returnType}:\n    return await _invoke(${JSON.stringify(javascriptName)})`;
  }
  const flattened = parameters.at(-1)?.flatten ? parameters.at(-1) : undefined;
  const positional = flattened ? parameters.slice(0, -1) : parameters;
  const signature = positional.map((parameter) => {
    const type = parameter.record ? `${parameter.record} | dict[str, Any] | None` : parameter.type;
    return `    ${parameter.pythonName}: ${type}${parameter.required ? "" : " | object = _MISSING"},`;
  });
  if (flattened) {
    signature.push(
      `    ${flattened.pythonName}: ${flattened.record} | dict[str, Any] | None | object = _MISSING,`,
      "    **kwargs: Any,",
    );
  }
  const body = ["    arguments: list[tuple[int, Any]] = []"];
  for (const [index, parameter] of positional.entries()) {
    if (parameter.required) body.push(`    arguments.append((${index}, ${parameter.pythonName}))`);
    else {
      body.push(
        `    if ${parameter.pythonName} is not _MISSING:`,
        `        arguments.append((${index}, ${parameter.pythonName}))`,
      );
    }
  }
  if (flattened) {
    body.push(
      "    if kwargs:",
      `        if ${flattened.pythonName} is not _MISSING:`,
      `            raise TypeError(${JSON.stringify(`${flattened.pythonName} and keyword fields are mutually exclusive`)})`,
      `        ${flattened.pythonName} = ${flattened.record}(**kwargs)`,
      `    if ${flattened.pythonName} is not _MISSING:`,
      `        arguments.append((${parameters.length - 1}, ${flattened.pythonName}))`,
    );
  }
  body.push(`    return await _invoke_positioned(${JSON.stringify(javascriptName)}, arguments)`);
  return [`async def ${pythonName}(`, ...signature, `) -> ${returnType}:`, ...body].join("\n");
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
