import { readFileSync } from "node:fs";

export interface RuntimeFunction {
  path: string;
  options?: "first" | "keyword";
  result?: "camelKeys";
}

export interface RuntimeModule {
  module: string;
  functions: Record<string, RuntimeFunction>;
}

export interface ModuleRoot {
  typescript: RuntimeModule;
  python: RuntimeModule;
}

export type ModuleRegistry = Record<string, ModuleRoot>;

export interface FixtureCase {
  name: string;
  function: string;
  args?: unknown[];
  options?: Record<string, unknown>;
  expected?: unknown;
  error?: string;
}

export interface FixtureSuite {
  root: string;
  cases: FixtureCase[];
}

export interface FixtureResult {
  name: string;
  result?: unknown;
  error?: string;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function expectedResults(suite: FixtureSuite): FixtureResult[] {
  return suite.cases.map((testCase) =>
    testCase.error === undefined
      ? { name: testCase.name, result: testCase.expected }
      : { name: testCase.name, error: testCase.error },
  );
}

export async function runTypeScriptFixture(
  registry: ModuleRegistry,
  suite: FixtureSuite,
): Promise<FixtureResult[]> {
  const root = registry[suite.root];
  if (!root) throw new Error(`Unknown fixture root: ${suite.root}`);
  const runtime = root.typescript;
  const module = (await import(runtime.module)) as Record<string, unknown>;

  return suite.cases.map((testCase) => {
    const definition = runtime.functions[testCase.function];
    if (!definition) throw new Error(`Unknown TypeScript function: ${testCase.function}`);
    const callable = resolveFunction(module, definition.path);
    const args = (testCase.args ?? []).map(decodeValue);
    try {
      const result =
        definition.options === "first"
          ? callable(testCase.options ?? {}, ...args)
          : callable(...args);
      return { name: testCase.name, result };
    } catch (cause) {
      return {
        name: testCase.name,
        error: cause instanceof Error ? cause.name : typeof cause,
      };
    }
  });
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
