/**
 * Bun-native Python module discovery and JavaScript-shaped test adapters.
 *
 * Most tests should use `polygotTest` from `./polygot-test.ts`. `bun_python`
 * embeds CPython through Bun FFI, so the machine must expose a compatible
 * Python shared library; set `BUN_PYTHON_PATH` when automatic discovery fails.
 *
 * A string target is authoritative and may be a dotted module name, file URL,
 * or Python source path. A {@link PolyglotTarget} derives candidates from a
 * package specifier and export key. Public Python snake_case exports become
 * camelCase properties, dataclass-style `as_dict()` results become JavaScript
 * objects, and method signatures are cached for keyword-argument routing.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// bun:ffi is a Bun runtime module, not a filesystem-resolvable npm package.
// eslint-disable-next-line import/no-unresolved
import { dlopen, FFIType, ptr } from "bun:ffi";
import type {
  NamedArgument as NamedArgumentValue,
  PythonConvertible,
  PythonProxy,
} from "bun_python";
import type { PolyglotTarget } from "./polygot-test.ts";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const pythonSitePackages = configurePython();
const { NamedArgument, ProxiedPyObject, python } = await import("bun_python");
if (pythonSitePackages) python.import("sys").path.insert(0, pythonSitePackages);
for (const path of workspacePythonRoots()) python.import("sys").path.insert(0, path);
const testSupport = python.runModule(`
import importlib.util
import inspect

def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load Python module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def module_exists(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (AttributeError, ImportError, ModuleNotFoundError):
        return False

def read_signature(function):
    return [
        (parameter.name, parameter.kind.name, parameter.default is inspect.Parameter.empty)
        for parameter in inspect.signature(function).parameters.values()
    ]
`);

type PythonValue = PythonProxy &
  ((...args: (PythonConvertible | NamedArgumentValue)[]) => PythonValue) & {
    valueOf(): unknown;
  };

type ParameterKind =
  "KEYWORD_ONLY" | "POSITIONAL_ONLY" | "POSITIONAL_OR_KEYWORD" | "VAR_KEYWORD" | "VAR_POSITIONAL";

type MethodSignature = [name: string, kind: ParameterKind, required: boolean][];

const signatureCache = new WeakMap<Function, MethodSignature>();
const moduleCache = new Map<string, PythonValue>();
const pythonSourceRoots = new Set<string>();

function configurePython(): string | undefined {
  const executable = resolve(repositoryRoot, ".venv/bin/python");
  if (!existsSync(executable)) return undefined;
  const source = execFileSync(
    executable,
    [
      "-c",
      "import json, os, sys, sysconfig; print(json.dumps({'basePrefix': sys.base_prefix, 'library': os.path.join(sysconfig.get_config_var('LIBDIR'), sysconfig.get_config_var('LDLIBRARY')), 'prefix': sys.prefix, 'purelib': sysconfig.get_paths()['purelib']}))",
    ],
    { encoding: "utf8" },
  );
  const info = JSON.parse(source) as {
    basePrefix: string;
    library: string;
    prefix: string;
    purelib: string;
  };
  process.env.BUN_PYTHON_PATH ??= info.library;
  if (!process.env.PYTHONHOME) setNativeEnvironment("PYTHONHOME", info.basePrefix);
  process.env.VIRTUAL_ENV ??= info.prefix;
  return info.purelib;
}

function workspacePythonRoots(): string[] {
  const packagesRoot = resolve(repositoryRoot, "packages/py");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesRoot, entry.name, "src"))
    .filter(existsSync);
}

function setNativeEnvironment(name: string, value: string): void {
  process.env[name] = value;
  if (process.platform === "win32") return;
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      setenv: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    },
  );
  const keyBuffer = Buffer.from(`${name}\0`);
  const valueBuffer = Buffer.from(`${value}\0`);
  const status = library.symbols.setenv(ptr(keyBuffer), ptr(valueBuffer), 1);
  library.close();
  if (status !== 0) throw new Error(`Could not set native environment variable ${name}`);
}

/**
 * Find and adapt a Python module to the requested TypeScript implementation type.
 *
 * A string is loaded exactly as supplied. A {@link PolyglotTarget} generates
 * Python candidates from its package and export names, probes them in order, and
 * throws with every attempted candidate when none exists.
 */
export function findModule<Module>(target: string): Module;
export function findModule<TModule, TKey extends keyof TModule>(
  target: PolyglotTarget<TModule, TKey>,
): TModule[TKey];
export function findModule(target: {
  moduleSpecifier: string;
  implementationName: PropertyKey;
}): unknown;
export function findModule(
  target: string | { moduleSpecifier: string; implementationName: PropertyKey },
): unknown {
  const moduleName = typeof target === "string" ? target : resolveModuleName(target);
  return createModule(loadModule(moduleName));
}

/**
 * Create a JavaScript-shaped object backed by a Python module.
 *
 * Callable exports inspect and cache their Python signatures before invocation.
 * Non-callable exports are exposed as lazy getters and recursively converted to
 * ordinary JavaScript values.
 */
export function createModule<Module>(pythonModule: PythonProxy): Module {
  const module = pythonModule as PythonValue;
  const adapter: Record<string, unknown> = {};
  const names = python.builtins.dir(module).valueOf() as string[];

  for (const pythonName of names.filter((name) => !name.startsWith("_"))) {
    const value = pythonProperty(module, pythonName);
    const name = toCamelCase(pythonName);
    if (python.builtins.callable(value).valueOf()) {
      adapter[name] = (...args: PythonConvertible[]) => invokePython(value, args);
    } else {
      Object.defineProperty(adapter, name, {
        enumerable: true,
        get: () => plainValue(pythonProperty(module, pythonName)),
      });
    }
  }
  return adapter as Module;
}

function pythonProperty(value: PythonValue, name: string): PythonValue {
  return (value as unknown as Record<string, PythonValue>)[name]!;
}

function pythonArgument(value: PythonConvertible): PythonConvertible {
  if (typeof value === "number" && Object.is(value, -0)) {
    return python.float("-0.0") as PythonProxy;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    const spelling = Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
    return python.float(spelling) as PythonProxy;
  }
  if (Array.isArray(value)) return value.map(pythonArgument);
  if (value instanceof Set) return new Set([...value].map(pythonArgument));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, pythonArgument(item)]),
    );
  }
  return value;
}

function invokePython(method: PythonValue, args: PythonConvertible[]): unknown {
  const signature = methodSignature(method);
  const keywordOnly = new Set(
    signature
      .filter((parameter) => parameter[1] === "KEYWORD_ONLY")
      .map((parameter) => parameter[0]),
  );
  const positionalCount = signature.filter(
    (parameter) => parameter[1] === "POSITIONAL_ONLY" || parameter[1] === "POSITIONAL_OR_KEYWORD",
  ).length;
  const requiredPositionalCount = signature.filter(
    (parameter) =>
      parameter[2] &&
      (parameter[1] === "POSITIONAL_ONLY" || parameter[1] === "POSITIONAL_OR_KEYWORD"),
  ).length;
  const hasVariadicPositionals = signature.some((parameter) => parameter[1] === "VAR_POSITIONAL");
  const acceptsArbitraryKeywords = signature.some((parameter) => parameter[1] === "VAR_KEYWORD");
  const invocationArgs: (PythonConvertible | NamedArgumentValue)[] = [];
  args.map(pythonArgument).forEach((argument, index) => {
    if (!isRecord(argument)) {
      invocationArgs.push(argument);
      return;
    }
    const entries = Object.entries(argument);
    const isKeywordRecord =
      (acceptsArbitraryKeywords && index >= requiredPositionalCount) ||
      (keywordOnly.size > 0 &&
        entries.every(([name]) => keywordOnly.has(name)) &&
        (entries.length > 0 || (!hasVariadicPositionals && index >= positionalCount)));
    if (isKeywordRecord) {
      invocationArgs.push(
        ...entries.map(([name, value]) => new NamedArgument(name, value as PythonConvertible)),
      );
    } else {
      invocationArgs.push(argument);
    }
  });
  return plainValue(method(...invocationArgs));
}

function methodSignature(method: PythonValue): MethodSignature {
  const cached = signatureCache.get(method);
  if (cached) return cached;
  const signature = testSupport.read_signature(method).valueOf() as MethodSignature;
  signatureCache.set(method, signature);
  return signature;
}

function plainValue(value: unknown): unknown {
  if (isPythonProxy(value) && pythonObject(value).isNone) return null;
  if (isPythonProxy(value) && python.builtins.hasattr(value, "as_dict").valueOf()) {
    value = pythonProperty(value, "as_dict")();
  }
  const plain = isPythonProxy(value) ? value.valueOf() : value;
  if (Array.isArray(plain)) return plain.map(plainValue);
  if (plain instanceof Set) return new Set([...plain].map(plainValue));
  if (plain instanceof Map) {
    const entries = [...plain].map(
      ([key, item]) =>
        [typeof key === "string" ? toCamelCase(key) : plainValue(key), plainValue(item)] as const,
    );
    return entries.every(([key]) => typeof key === "string")
      ? Object.fromEntries(entries)
      : new Map(entries);
  }
  return plain;
}

function pythonObject(value: PythonValue): { isNone: boolean } {
  return (value as unknown as Record<symbol, { isNone: boolean }>)[ProxiedPyObject]!;
}

function resolveModuleName(info: {
  moduleSpecifier: string;
  implementationName: PropertyKey;
}): string {
  const implementationName = String(info.implementationName);
  const candidates = moduleCandidates(info.moduleSpecifier, implementationName);
  for (const candidate of candidates) {
    addLocalPackageRoot(candidate);
    if (testSupport.module_exists(candidate).valueOf()) return candidate;
  }
  throw new Error(
    `No Python equivalent found for ${info.moduleSpecifier}.${implementationName}. Tried: ${candidates.join(", ")}`,
  );
}

function moduleCandidates(moduleSpecifier: string, implementationName: string): string[] {
  if (
    moduleSpecifier.startsWith(".") ||
    moduleSpecifier.startsWith("file:") ||
    isAbsolute(moduleSpecifier)
  ) {
    return [];
  }

  const segments = moduleSpecifier.split("/");
  const scoped = moduleSpecifier.startsWith("@");
  const scope = scoped ? segments.shift()?.slice(1) : undefined;
  const packageName = segments.shift();
  if (!packageName) return [];

  const namespace = scope ? toSnakeToken(scope.replace(/-/g, "_")) : undefined;
  const packageTokens = packageName.split("-").map(toSnakeToken);
  const moduleTokens = segments.flatMap((segment) => segment.split("-").map(toSnakeToken));
  const implementationToken = toSnakeToken(implementationName);
  return packageTokens.map((_, offset) =>
    [
      ...(namespace ? [namespace] : []),
      ...packageTokens.slice(offset),
      ...moduleTokens,
      implementationToken,
    ].join("."),
  );
}

function loadModule(moduleName: string): PythonValue {
  const filePath = resolveModuleFile(moduleName);
  const cacheKey = filePath ?? moduleName;
  const cached = moduleCache.get(cacheKey);
  if (cached) return cached;

  let module: PythonValue;
  if (filePath) {
    addPythonSourceRoot(dirname(filePath));
    module = testSupport.load_module(filePath, `dbx_tools_test_${moduleCache.size}`) as PythonValue;
  } else {
    addLocalPackageRoot(moduleName);
    module = python.import(moduleName) as PythonValue;
  }
  moduleCache.set(cacheKey, module);
  return module;
}

function resolveModuleFile(moduleName: string): string | undefined {
  const candidate = moduleName.startsWith("file:")
    ? fileURLToPath(moduleName)
    : isAbsolute(moduleName)
      ? moduleName
      : resolve(process.cwd(), moduleName);
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (
    moduleName.startsWith("file:") ||
    moduleName.startsWith(".") ||
    moduleName.endsWith(".py") ||
    isAbsolute(moduleName)
  ) {
    throw new Error(`Python module file does not exist: ${candidate}`);
  }
  return undefined;
}

function addLocalPackageRoot(moduleName: string): void {
  const [namespace, packageName] = moduleName.split(".");
  if (namespace !== "dbx_tools" || !packageName) return;
  const sourceRoot = resolve(repositoryRoot, "packages/py", packageName, "src");
  if (existsSync(sourceRoot) && statSync(sourceRoot).isDirectory()) {
    addPythonSourceRoot(sourceRoot);
  }
}

function addPythonSourceRoot(path: string): void {
  if (pythonSourceRoots.has(path)) return;
  python.import("sys").path.insert(0, path);
  pythonSourceRoots.add(path);
}

function toSnakeToken(value: string): string {
  const token = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .toLowerCase();
  return /^\d/.test(token) ? `_${token}` : token;
}

function isPythonProxy(value: unknown): value is PythonValue {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    ProxiedPyObject in value
  );
}

function isRecord(value: unknown): value is Record<string, PythonConvertible> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, token: string) => token.toUpperCase());
}
