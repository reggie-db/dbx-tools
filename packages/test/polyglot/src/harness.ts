import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export type Runtime = "typescript" | "python";
export type RuntimeValue = string | Partial<Record<Runtime, string>>;
export type InvokeMode = "positional" | "optionsFirst" | "keywordOptions";
export type ResultMode = "identity" | "camelKeys" | "string";

export interface TargetOverrides {
  module?: RuntimeValue;
  path?: RuntimeValue;
  invoke?: Partial<Record<Runtime, InvokeMode>>;
  result?: Partial<Record<Runtime, ResultMode>>;
}

export interface FixtureCase extends TargetOverrides {
  name: string;
  function?: string;
  args?: unknown[];
  options?: Record<string, unknown>;
  expected?: unknown;
  error?: string;
}

export interface FunctionDefinition extends TargetOverrides {
  tests?: FixtureCase[];
}

export interface FixtureSuite {
  $schema?: string;
  modules?: Partial<Record<Runtime, string>>;
  functions?: Record<string, FunctionDefinition>;
  tests?: FixtureCase[];
}

export interface FixtureResult {
  name: string;
  result?: unknown;
  error?: string;
}

interface ResolvedCase {
  test: FixtureCase;
  target: {
    module: string;
    path: string;
    invoke: InvokeMode;
    result: ResultMode;
  };
}

export function readFixture(path: string): FixtureSuite {
  const fixturePath = resolve(path);
  const fixtureRoot = findFixtureRoot(fixturePath);
  const directories: string[] = [];
  for (let directory = dirname(fixturePath); ; directory = dirname(directory)) {
    directories.push(directory);
    if (directory === fixtureRoot) break;
  }

  return [
    ...directories.reverse().map(readDefault).filter(isDefined),
    readDocument(fixturePath),
  ].reduce(mergeSuites, {});
}

export function fixtureCases(suite: FixtureSuite): FixtureCase[] {
  const nested = Object.entries(suite.functions ?? {}).flatMap(([name, definition]) =>
    (definition.tests ?? []).map((test) => ({ ...test, function: test.function ?? name })),
  );
  return [...nested, ...(suite.tests ?? [])];
}

export function expectedResults(suite: FixtureSuite): FixtureResult[] {
  return fixtureCases(suite).map((testCase) =>
    testCase.error === undefined
      ? { name: testCase.name, result: testCase.expected }
      : { name: testCase.name, error: testCase.error },
  );
}

export async function runTypeScriptFixture(suite: FixtureSuite): Promise<FixtureResult[]> {
  const moduleCache = new Map<string, Record<string, unknown>>();
  const results: FixtureResult[] = [];

  for (const resolved of resolveCases(suite, "typescript")) {
    const module =
      moduleCache.get(resolved.target.module) ??
      ((await import(resolved.target.module)) as Record<string, unknown>);
    moduleCache.set(resolved.target.module, module);
    const callable = resolveFunction(module, resolved.target.path);
    const args = (resolved.test.args ?? []).map(decodeValue);
    try {
      const value =
        resolved.target.invoke === "optionsFirst"
          ? callable(resolved.test.options ?? {}, ...args)
          : resolved.target.invoke === "positional"
            ? callable(...args)
            : throwUnsupportedInvoke("typescript", resolved.target.invoke);
      results.push({
        name: resolved.test.name,
        result: normalizeResult(value, resolved.target.result),
      });
    } catch (cause) {
      results.push({
        name: resolved.test.name,
        error: cause instanceof Error ? cause.name : typeof cause,
      });
    }
  }
  return results;
}

export function resolveCases(suite: FixtureSuite, runtime: Runtime): ResolvedCase[] {
  return fixtureCases(suite).map((test) => {
    const definition = test.function ? suite.functions?.[test.function] : undefined;
    const defaultPath = test.function;
    const module = runtimeValue(test.module, runtime) ?? runtimeValue(definition?.module, runtime);
    const path =
      runtimeValue(test.path, runtime) ?? runtimeValue(definition?.path, runtime) ?? defaultPath;
    const suiteModule = suite.modules?.[runtime];
    if (!path) throw new Error(`Fixture '${test.name}' needs a function name or path`);
    if (!module && !suiteModule) {
      throw new Error(`Fixture '${test.name}' needs a ${runtime} module`);
    }
    return {
      test,
      target: {
        module: module ?? suiteModule!,
        path,
        invoke: test.invoke?.[runtime] ?? definition?.invoke?.[runtime] ?? "positional",
        result: test.result?.[runtime] ?? definition?.result?.[runtime] ?? "identity",
      },
    };
  });
}

function readDocument(path: string): FixtureSuite {
  const source = readFileSync(path, "utf8");
  switch (extname(path)) {
    case ".json":
      return JSON.parse(source) as FixtureSuite;
    case ".yaml":
    case ".yml":
      return fixtureYaml().parse(source) as FixtureSuite;
    default:
      throw new Error(`Unsupported fixture format: ${path}`);
  }
}

function findFixtureRoot(path: string): string {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (basename(directory) === "fixtures") return directory;
    if (directory === dirname(directory)) return dirname(path);
  }
}

function readDefault(directory: string): FixtureSuite | undefined {
  const paths = ["default.json", "default.yaml", "default.yml"]
    .map((name) => join(directory, name))
    .filter(existsSync);
  if (paths.length > 1) throw new Error(`Multiple fixture defaults in ${directory}`);
  return paths[0] ? readDocument(paths[0]) : undefined;
}

function mergeSuites(base: FixtureSuite, override: FixtureSuite): FixtureSuite {
  const functions = { ...base.functions };
  for (const [name, definition] of Object.entries(override.functions ?? {})) {
    const inherited = functions[name];
    functions[name] = {
      ...inherited,
      ...definition,
      invoke: { ...inherited?.invoke, ...definition.invoke },
      result: { ...inherited?.result, ...definition.result },
      tests: [...(inherited?.tests ?? []), ...(definition.tests ?? [])],
    };
  }
  return {
    ...base,
    ...override,
    modules: { ...base.modules, ...override.modules },
    functions,
    tests: [...(base.tests ?? []), ...(override.tests ?? [])],
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function fixtureYaml(): { parse(source: string): unknown } {
  return (globalThis as typeof globalThis & { Bun: { YAML: { parse(source: string): unknown } } })
    .Bun.YAML;
}

function throwUnsupportedInvoke(runtime: Runtime, mode: InvokeMode): never {
  throw new Error(`Unsupported ${runtime} invoke mode: ${mode}`);
}

function runtimeValue(value: RuntimeValue | undefined, runtime: Runtime): string | undefined {
  return typeof value === "string" ? value : value?.[runtime];
}

function resolveFunction(
  module: Record<string, unknown>,
  path: string,
): (...args: unknown[]) => unknown {
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, module);
  if (typeof value !== "function") throw new TypeError(`Not a callable export: ${path}`);
  return value as (...args: unknown[]) => unknown;
}

function normalizeResult(value: unknown, mode: ResultMode): unknown {
  if (mode === "string") return String(value);
  if (Array.isArray(value)) return value.map((item) => normalizeResult(item, mode));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      mode === "camelKeys" ? camelKey(key) : key,
      normalizeResult(item, mode),
    ]),
  );
}

function camelKey(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== "object") return value;

  const descriptor = value as { $type?: string; values?: unknown[] };
  switch (descriptor.$type) {
    case "negativeZero":
      return -0;
    case "set":
      return new Set((descriptor.values ?? []).map(decodeValue));
    case "cycle": {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    }
    case "nan":
      return Number.NaN;
    default:
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, decodeValue(item)]),
      );
  }
}
