/**
 * Static extraction of a module's own top-level named exports, via oxc-parser
 * (a fast, TypeScript-aware parser). Used by the barrel generator to hoist
 * names that are unique across a package to the top level of its barrel.
 *
 * Only a module's OWN declared names are returned - names it declares with
 * `export const/function/class/enum/interface/type` or names it re-labels in a
 * local `export { local as exported }`. Deliberately excluded:
 *
 *   - `export default` (no stable importable name);
 *   - `export * from "..."` / `export * as ns from "..."` (opaque or already a
 *     namespace);
 *   - any `export { ... } from "..."` re-export with a `source` (the name is
 *     owned by another module, so hoisting it here would double-count).
 *
 * Each name carries whether it is TYPE-only (`interface` / `type` alias /
 * `export type { ... }`), so the barrel can emit `export type { ... }` for it -
 * required under `isolatedModules`, where re-exporting a type through a value
 * `export { ... }` is a hard error (TS1205). `export function` names are marked
 * `isFunction` so the barrel leaves them namespace-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import type { parseSync as OxcParseSync } from "oxc-parser";

const require = createRequire(import.meta.url);

/** oxc's `parseSync`, loaded lazily so importing this module stays cheap. */
let parseSyncFn: typeof OxcParseSync | undefined;
function parseSync(filename: string, source: string): ReturnType<typeof OxcParseSync> {
  parseSyncFn ??= (require("oxc-parser") as typeof import("oxc-parser")).parseSync;
  return parseSyncFn(filename, source);
}

/** A parsed top-level statement, narrowed to the discriminant every caller reads. */
export type ModuleStatement = { readonly type: string };

/**
 * `file`'s top-level statements, or `[]` when it cannot be read or parsed. The
 * single parse entry point for the whole engine: the barrel generator reads the
 * same oxc AST to decide whether a file exports anything at all and to read a
 * hand-authored `exports.ts`, so there is exactly one TypeScript parser here.
 */
export function moduleStatements(file: string): readonly ModuleStatement[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    return parseSync(file, source).program.body;
  } catch {
    return [];
  }
}

/** One exported name plus whether it is type-only (needs `export type`). */
export interface ModuleExport {
  readonly name: string;
  readonly isType: boolean;
  /** `export function` / `export async function` - never hoisted to the barrel. */
  readonly isFunction: boolean;
}

/** Plain public function reachable through a module's re-export graph. */
export interface PublicFunctionExport {
  readonly name: string;
  readonly sourceFile: string;
  readonly sourceName: string;
  readonly async: boolean;
}

/** Declaration node types that are inherently type-only. */
const TYPE_DECLARATIONS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration"]);

/** Declaration node types that are functions (not hoisted). */
const FUNCTION_DECLARATIONS = new Set(["FunctionDeclaration", "TSDeclareFunction"]);

/**
 * Parse `file` and return its own top-level named exports (see the module
 * docstring for what's included). Returns `[]` on a read/parse error - a
 * module the parser chokes on simply contributes no hoisted names.
 */
export function moduleExports(file: string): ModuleExport[] {
  const body = moduleStatements(file);

  // Dedupe within the module: an overloaded `export function f(...)` declares
  // `f` once per signature, but it's a single exported name. First occurrence
  // wins (a value declaration and a same-named type would be unusual and are
  // collapsed to whichever appears first).
  const byName = new Map<string, ModuleExport>();
  const push = (e: ModuleExport): void => {
    if (!byName.has(e.name)) byName.set(e.name, e);
  };
  for (const stmt of body) {
    if (stmt.type !== "ExportNamedDeclaration") continue;
    // Narrow to the fields we read; oxc's union is wider than what we touch.
    const node = stmt as {
      exportKind?: "value" | "type";
      source?: { value?: string } | null;
      declaration?: {
        type: string;
        id?: { name?: string } | null;
        declarations?: { id?: { type?: string; name?: string } | null }[];
      } | null;
      specifiers?: {
        exported?: { name?: string; value?: string };
        exportKind?: "value" | "type";
      }[];
    };
    // `export { ... } from "..."` re-exports another module's names; skip.
    if (node.source) continue;

    const stmtIsType = node.exportKind === "type";
    const decl = node.declaration;
    if (decl) {
      if (decl.id?.name) {
        push({
          name: decl.id.name,
          isType: stmtIsType || TYPE_DECLARATIONS.has(decl.type),
          isFunction: FUNCTION_DECLARATIONS.has(decl.type),
        });
      }
      for (const d of decl.declarations ?? []) {
        if (d.id?.type === "Identifier" && d.id.name) {
          push({ name: d.id.name, isType: stmtIsType, isFunction: false });
        }
      }
    }
    for (const spec of node.specifiers ?? []) {
      const name = spec.exported?.name ?? spec.exported?.value;
      if (!name) continue;
      push({
        name,
        isType: stmtIsType || spec.exportKind === "type",
        isFunction: false,
      });
    }
  }
  return [...byName.values()];
}

/**
 * Resolve every plain named function exported by `file`, following relative
 * named and star re-exports. Non-function values and types are ignored. A
 * generator, declaration-only overload, or conflicting function definition is
 * rejected because a generic runtime bridge cannot preserve those semantics.
 */
export function publicFunctionExports(file: string): PublicFunctionExport[] {
  return [...collectPublicFunctions(resolve(file), new Set()).values()]
    .map(({ name, sourceFile, sourceName, async }) => ({
      name,
      sourceFile,
      sourceName,
      async,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Names of namespace exports declared as `export * as name from "..."`. */
export function publicNamespaceExports(file: string): string[] {
  return moduleStatements(file)
    .flatMap((statement) => {
      if (statement.type !== "ExportAllDeclaration") return [];
      const exported = (
        statement as {
          exported?: { name?: string; value?: string } | null;
        }
      ).exported;
      const name = exported?.name ?? exported?.value;
      return name ? [name] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

interface ResolvedFunctionExport extends PublicFunctionExport {
  readonly source: string;
}

function collectPublicFunctions(
  file: string,
  visiting: Set<string>,
): Map<string, ResolvedFunctionExport> {
  if (visiting.has(file)) return new Map();
  visiting.add(file);
  const source = readFileSync(file, "utf8");
  const body = parseSync(file, source).program.body;
  const functions = new Map<string, ResolvedFunctionExport>();
  const localFunctions = new Map<string, FunctionNode>();

  for (const statement of body) {
    const node = statement as FunctionNode & { declaration?: FunctionNode | null };
    const declaration =
      node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction"
        ? node
        : node.declaration;
    if (declaration?.type === "FunctionDeclaration" || declaration?.type === "TSDeclareFunction") {
      const name = declaration.id?.name;
      if (name) localFunctions.set(name, declaration);
    }
  }

  const add = (exported: ResolvedFunctionExport): void => {
    const existing = functions.get(exported.name);
    if (existing && existing.source !== exported.source) {
      throw new Error(
        `Conflicting function export ${exported.name} from ${existing.source} and ${exported.source}`,
      );
    }
    functions.set(exported.name, exported);
  };

  for (const statement of body) {
    if (statement.type === "ExportAllDeclaration") {
      const node = statement as { exported?: unknown; source?: { value?: string } };
      if (node.exported || !node.source?.value) continue;
      for (const exported of collectPublicFunctions(
        resolveModuleSpecifier(file, node.source.value),
        visiting,
      ).values()) {
        add(exported);
      }
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const node = statement as {
      declaration?: FunctionNode | null;
      source?: { value?: string } | null;
      specifiers?: {
        local?: { name?: string; value?: string };
        exported?: { name?: string; value?: string };
        exportKind?: "value" | "type";
      }[];
      exportKind?: "value" | "type";
    };
    if (
      node.declaration?.type === "FunctionDeclaration" ||
      node.declaration?.type === "TSDeclareFunction"
    ) {
      add(parseFunctionNode(file, node.declaration));
    }
    if (node.exportKind === "type") continue;
    if (node.source?.value) {
      const available = collectPublicFunctions(
        resolveModuleSpecifier(file, node.source.value),
        visiting,
      );
      for (const specifier of node.specifiers ?? []) {
        if (specifier.exportKind === "type") continue;
        const local = specifier.local?.name ?? specifier.local?.value;
        const exportedName = specifier.exported?.name ?? specifier.exported?.value;
        const target = local ? available.get(local) : undefined;
        if (target && exportedName) {
          add({
            name: exportedName,
            source: target.source,
            sourceFile: target.sourceFile,
            sourceName: target.sourceName,
            async: target.async,
          });
        }
      }
      continue;
    }
    for (const specifier of node.specifiers ?? []) {
      if (specifier.exportKind === "type") continue;
      const local = specifier.local?.name ?? specifier.local?.value;
      const exportedName = specifier.exported?.name ?? specifier.exported?.value;
      const target = local ? localFunctions.get(local) : undefined;
      if (target && exportedName) {
        const parsed = parseFunctionNode(file, target);
        add({
          name: exportedName,
          source: parsed.source,
          sourceFile: parsed.sourceFile,
          sourceName: parsed.sourceName,
          async: parsed.async,
        });
      }
    }
  }

  visiting.delete(file);
  return functions;
}

interface FunctionNode {
  readonly type: string;
  readonly id?: { readonly name?: string } | null;
  readonly generator?: boolean;
  readonly declare?: boolean;
  readonly body?: unknown;
  readonly async?: boolean;
}

function parseFunctionNode(file: string, node: FunctionNode): ResolvedFunctionExport {
  const name = node.id?.name;
  if (!name) throw new Error(`Anonymous exported function is not supported in ${file}`);
  if (node.generator) throw new Error(`Generator export ${name} is not supported in ${file}`);
  if (node.type === "TSDeclareFunction" || node.declare || !node.body) {
    throw new Error(`Declaration-only function export ${name} is not supported in ${file}`);
  }
  return {
    name,
    source: `${file}#${name}`,
    sourceFile: file,
    sourceName: name,
    async: node.async === true,
  };
}

function resolveModuleSpecifier(importer: string, specifier: string): string {
  if (!specifier.startsWith(".")) return createRequire(importer).resolve(specifier);
  const base = resolve(dirname(importer), specifier);
  const extension = extname(base);
  const candidates = extension
    ? [
        base,
        ...(extension === ".js" || extension === ".jsx"
          ? [`${base.slice(0, -extension.length)}.ts`, `${base.slice(0, -extension.length)}.tsx`]
          : []),
      ]
    : [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        `${base}.mjs`,
        `${base}.cjs`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
        resolve(base, "index.js"),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not resolve ${specifier} from ${importer}`);
}
