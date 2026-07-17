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
 * `export { ... }` is a hard error (TS1205).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { parseSync as OxcParseSync } from "oxc-parser";

const require = createRequire(import.meta.url);

/** oxc's `parseSync`, loaded lazily so importing this module stays cheap. */
let parseSyncFn: typeof OxcParseSync | undefined;
function parseSync(filename: string, source: string): ReturnType<typeof OxcParseSync> {
  parseSyncFn ??= (require("oxc-parser") as typeof import("oxc-parser")).parseSync;
  return parseSyncFn(filename, source);
}

/** One exported name plus whether it is type-only (needs `export type`). */
export interface ModuleExport {
  readonly name: string;
  readonly isType: boolean;
}

/** Declaration node types that are inherently type-only. */
const TYPE_DECLARATIONS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration"]);

/**
 * Parse `file` and return its own top-level named exports (see the module
 * docstring for what's included). Returns `[]` on a read/parse error - a
 * module the parser chokes on simply contributes no hoisted names.
 */
export function moduleExports(file: string): ModuleExport[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  let body: readonly { type: string }[];
  try {
    body = parseSync(file, source).program.body;
  } catch {
    return [];
  }

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
        push({ name: decl.id.name, isType: stmtIsType || TYPE_DECLARATIONS.has(decl.type) });
      }
      for (const d of decl.declarations ?? []) {
        if (d.id?.type === "Identifier" && d.id.name) {
          push({ name: d.id.name, isType: stmtIsType });
        }
      }
    }
    for (const spec of node.specifiers ?? []) {
      const name = spec.exported?.name ?? spec.exported?.value;
      if (!name) continue;
      push({ name, isType: stmtIsType || spec.exportKind === "type" });
    }
  }
  return [...byName.values()];
}
