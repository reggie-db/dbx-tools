/**
 * Barrel generator, driven by barrelsby.
 *
 * For every package it writes a single `index.ts` **at the package root** (above
 * `src/`) that namespace-re-exports every module under `src/`, subject to two rules:
 *   1. a file/folder whose name starts with `_` is private and never barrelled;
 *   2. only files that actually contain an `export` are re-exported.
 *
 * A hand-authored `exports.ts` sitting next to the generated `index.ts` (a Vite-style
 * override) is spliced in last and wins: its exports are appended, and any generated
 * `export * as <ns>` whose namespace it also declares is dropped so the custom one
 * takes priority. This keeps the barrel auto-generated while letting you add or
 * override individual exports.
 *
 * barrelsby emits flat `export * from "./x"` lines; we relocate the barrel to
 * `<pkg>/index.ts`, deepen paths (`./x` -> `./src/x`), then rewrite each line to
 * `export * as <name> from "./src/x"` (camelCase namespace from path segments;
 * invalid identifiers suffixed with `Module`).
 *
 * On top of the namespace lines, every TYPE export that is UNIQUE across the
 * package (declared in exactly one module) is also HOISTED to the barrel's top
 * level via `export type { ... }`, so consumers can write `GenieMessage` instead
 * of `genieModel.GenieMessage`. Values (functions, classes, consts, enums) are
 * NOT hoisted - they keep the module namespace (`string.toSlug(...)`), which
 * keeps runtime call sites explicitly namespaced. A type declared by two or more
 * modules is ambiguous and stays namespace-only; `export type { ... }` is
 * required under `isolatedModules`. Names a hand-authored `exports.ts` declares
 * are never hoisted (that file wins).
 *
 * The result gets an optional caller {@link BarrelModifier}, then a do-not-edit
 * header + read-only bit (see `./generated`).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import { exec } from "@dbx-tools/node-core";
import { find } from "@dbx-tools/shared-file-scan";
import isIdentifier from "is-identifier";
import { header, makeReadonly, makeWritable, stampGenerated, type HeaderOpts } from "./generated";
import { logger } from "./log";
import { moduleExports } from "./module-exports";
import { escapeRegExp, isModuleFile, repoRoot, toPosix, workspacePackages } from "./workspace";

const log = logger.withTag("projen:barrels");
const require = createRequire(import.meta.url);

// barrelsby is CLI-only (its package `main` is missing), so run its bin with node.
// Resolved lazily (not at module load) so importing this module during synth does
// not require barrelsby to be installed yet.
let barrelsbyCli: string | undefined;
function barrelsbyBin(): string {
  return (barrelsbyCli ??= require.resolve("barrelsby/bin/cli.js"));
}

/** Top-level statement types that make a file a re-exportable module. */
const EXPORT_STATEMENT_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "TSExportAssignment",
]);

// Lazy so importing this module during synth does not require the parser yet.
let parseFn:
  ((code: string, options?: Record<string, unknown>) => { body: { type: string }[] }) | undefined;
function parseModuleExports(code: string, file: string): { body: { type: string }[] } {
  parseFn ??= require("@typescript-eslint/typescript-estree").parse;
  const ext = extname(file).toLowerCase();
  return parseFn!(code, {
    filePath: file,
    jsx: ext === ".tsx" || ext === ".jsx",
    loc: false,
    range: false,
    errorOnUnknownASTType: false,
  });
}

/** True when the file has at least one top-level export statement. */
function hasExport(file: string): boolean {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return false;
  }

  try {
    return parseModuleExports(source, file).body.some((stmt) =>
      EXPORT_STATEMENT_TYPES.has(stmt.type),
    );
  } catch {
    return false;
  }
}

/** Transform applied to a package's barrel contents before it is written. */
export type BarrelModifier = (content: string, ctx: { readonly packageDir: string }) => string;

/**
 * The do-not-edit banner stamped on every generated barrel. Deliberately stable
 * (no timestamp) so a barrel is a pure function of its exporting modules - which
 * is what lets {@link generateForPackage} skip the rewrite when nothing changed.
 */
const BARREL_HEADER: HeaderOpts = {
  tool: "projen watch (barrelsby)",
  source: "the exporting modules in ./src",
};

/** `pnpm-workspace` -> `pnpmWorkspace`; nested paths join in camelCase. */
function kebabToCamel(segment: string): string {
  return segment.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Derive a valid namespace identifier from a relocated barrel module path. */
function modulePathToNamespace(modulePath: string): string {
  const rel = modulePath.replace(/^\.\/src\//, "").replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  const segments = rel.split("/").map(kebabToCamel);
  let name =
    segments.length === 1
      ? segments[0]!
      : segments[0]! +
        segments
          .slice(1)
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join("");
  if (!isIdentifier(name)) {
    name = `${name}Module`;
  }
  return name;
}

/** Rewrite flat barrelsby `export * from` lines as `export * as <ns> from`. */
function namespaceBarrelExports(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const match = /^(export \* from )"(.+)"(;?)\s*$/.exec(line);
      if (!match) return line;
      const modulePath = match[2]!;
      const ns = modulePathToNamespace(modulePath);
      return `export * as ${ns} from "${modulePath}";`;
    })
    .join("\n");
}

/** A `./src/x` module path parsed out of a generated `export * as <ns>` line. */
function namespaceLines(content: string): { ns: string; modulePath: string }[] {
  const out: { ns: string; modulePath: string }[] = [];
  for (const line of content.split("\n")) {
    const match = /^export \* as (\w+) from "(\.\/src\/.+)";\s*$/.exec(line);
    if (match) out.push({ ns: match[1]!, modulePath: match[2]! });
  }
  return out;
}

/**
 * Append hoisted top-level `export type { ... }` re-exports for every TYPE
 * export that is UNIQUE across the package's modules. Values are never hoisted
 * (they keep the module namespace). A type declared by two or more modules is
 * ambiguous and left namespace-only. `suppress` names (a hand-authored
 * `exports.ts` surface) are never hoisted so that file stays authoritative.
 */
function hoistUniqueExports(content: string, pkgDir: string, suppress: Set<string>): string {
  const namespaces = namespaceLines(content);
  if (namespaces.length === 0) return content;

  // A hoisted name must never collide with a generated `export * as <ns>`
  // namespace (e.g. a `mixin.ts` exporting a `mixin` value alongside the
  // `export * as mixin` line), so treat every namespace id as suppressed too.
  const blocked = new Set<string>(suppress);
  for (const { ns } of namespaces) blocked.add(ns);

  // Only TYPE exports are hoisted, so uniqueness is tallied over types alone:
  // name -> { count, owning module }, to find types declared in exactly one module.
  const seen = new Map<string, { count: number; modulePath: string }>();
  const perModule = new Map<string, string[]>();
  for (const { modulePath } of namespaces) {
    const abs = join(pkgDir, modulePath.replace(/^\.\//, ""));
    const typeNames = moduleExports(withTsExt(abs))
      .filter((e) => e.isType)
      .map((e) => e.name);
    perModule.set(modulePath, typeNames);
    for (const name of typeNames) {
      const prior = seen.get(name);
      if (prior) prior.count += 1;
      else seen.set(name, { count: 1, modulePath });
    }
  }

  const lines: string[] = [];
  for (const { modulePath } of namespaces) {
    const types: string[] = [];
    for (const name of perModule.get(modulePath) ?? []) {
      if (blocked.has(name)) continue;
      const entry = seen.get(name);
      // Unique across the package AND this is the module that owns it.
      if (!entry || entry.count !== 1 || entry.modulePath !== modulePath) continue;
      types.push(name);
    }
    if (types.length) lines.push(`export type { ${types.join(", ")} } from "${modulePath}";`);
  }
  if (lines.length === 0) return content;
  return `${content.replace(/\n+$/, "")}\n${lines.join("\n")}\n`;
}

/** Resolve a barrel module path (`./src/x`, extensionless) to its on-disk `.ts(x)` file. */
function withTsExt(absNoExt: string): string {
  for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
    if (existsSync(absNoExt + ext)) return absNoExt + ext;
  }
  return `${absNoExt}.ts`;
}

/** Hand-authored override barrel: a sibling of the generated `index.ts`. */
const CUSTOM_EXPORTS_FILE = "exports.ts";

/**
 * Best-effort set of the top-level export names a module declares - named
 * declarations, `export { x }` specifiers, `export * as ns`, and default. A bare
 * `export *` re-exports opaque names that can't be resolved statically, so a custom
 * `exports.ts` should name what it means to override explicitly.
 */
function customExportNames(file: string): Set<string> {
  const names = new Set<string>();
  let body: Array<Record<string, any>>;
  try {
    body = parseModuleExports(readFileSync(file, "utf8"), file).body as Array<Record<string, any>>;
  } catch {
    return names;
  }
  const add = (node: Record<string, any> | undefined | null): void => {
    if (node && typeof node.name === "string") names.add(node.name);
    else if (node && typeof node.value === "string") names.add(node.value);
  };
  for (const stmt of body) {
    if (stmt.type === "ExportDefaultDeclaration") {
      names.add("default");
    } else if (stmt.type === "ExportAllDeclaration") {
      add(stmt.exported); // `export * as ns from ...`; a bare `export *` has none
    } else if (stmt.type === "ExportNamedDeclaration") {
      for (const spec of stmt.specifiers ?? []) add(spec.exported);
      const decl = stmt.declaration;
      if (decl?.id) add(decl.id);
      for (const d of decl?.declarations ?? []) if (d.id?.type === "Identifier") add(d.id);
    }
  }
  return names;
}

/**
 * Splice a hand-authored `<pkg>/exports.ts` into the barrel. Any generated
 * `export * as <ns>` whose namespace the custom file also declares is dropped (so the
 * custom export wins - a plain `export *` cannot otherwise override an explicit
 * `export * as`), then the whole module is re-exported last.
 */
function mergeCustomExports(content: string, pkgDir: string): string {
  if (!existsSync(join(pkgDir, CUSTOM_EXPORTS_FILE))) return content;
  const overridden = customExportNames(join(pkgDir, CUSTOM_EXPORTS_FILE));
  const kept = content.split("\n").filter((line) => {
    const ns = /^export \* as (\w+) from /.exec(line)?.[1];
    return !(ns && overridden.has(ns));
  });
  return `${kept.join("\n").replace(/\n+$/, "")}\nexport * from "./exports";\n`;
}

/**
 * Rebuild one package's root barrel. Returns 1 only if the barrel's contents
 * actually changed - a module was added, removed, renamed, or toggled its
 * `export` - and 0 for a no-op. An edit *inside* an already-exported module (even
 * adding a new named export) leaves the namespace `export * as … from "./src/x"`
 * list identical, so it is a no-op.
 */
function generateForPackage(pkgDir: string, modifier?: BarrelModifier): number {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) return 0;

  const rootBarrel = join(pkgDir, "index.ts");
  const tmpBarrel = join(srcDir, "index.ts");
  // Snapshot the current barrel so we can tell a real change (module added/removed/
  // renamed) from an edit *inside* an already-exported module, which leaves the flat
  // `export * from "./src/x"` list - and therefore this file - byte-for-byte identical.
  const before = existsSync(rootBarrel) ? readFileSync(rootBarrel, "utf8") : undefined;

  // Rule 2: src files with no export are excluded by exact (tail-anchored) path.
  // find.findFiles yields paths relative to `srcDir` (its cwd) already, so they map
  // straight to the barrelsby exclude regex; `hasExport` parses each file via
  // typescript-estree and needs the absolute path.
  const noExport = [...find.findFiles("**/*", { cwd: srcDir })]
    .filter(isModuleFile)
    .filter((f) => !hasExport(join(srcDir, f)))
    .map((f) => `${escapeRegExp(toPosix(f))}$`);

  // Unlock the read-only barrels so barrelsby's --delete / our rewrite can run.
  makeWritable(rootBarrel);
  makeWritable(tmpBarrel);

  const excludes = [
    "(^|/)_", // rule 1: any path segment starting with `_`
    "\\.(test|spec)\\.", // test files
    "\\.d\\.ts$", // declaration files
    ...noExport,
  ];
  const args = [
    barrelsbyBin(),
    "--directory",
    srcDir,
    "--location",
    "top", // one barrel at the src root...
    "--structure",
    "flat", // ...flat `export * from "./x"` for the whole subtree
    "--delete", // remove the stale barrel first
    "--noHeader", // we add our own do-not-edit header when stamping
    ...excludes.flatMap((e) => ["--exclude", e]),
  ];
  const result = exec.spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "capture",
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    log.error(`barrelsby failed for ${toPosix(relative(repoRoot, srcDir))}`, result.stderr);
    throw new Error(
      `barrelsby failed for ${toPosix(relative(repoRoot, srcDir))}${result.stderr ? `: ${result.stderr}` : ""}`,
    );
  }

  // No eligible modules -> no barrel: drop any stale root barrel and bail.
  if (!existsSync(tmpBarrel)) {
    if (existsSync(rootBarrel)) {
      makeWritable(rootBarrel);
      rmSync(rootBarrel, { force: true });
    }
    return 0;
  }

  // Relocate src/index.ts -> <pkg>/index.ts, deepen paths, namespace each export.
  let content = namespaceBarrelExports(
    readFileSync(tmpBarrel, "utf8").replace(/from "\.\//g, 'from "./src/'),
  );
  rmSync(tmpBarrel, { force: true });
  if (modifier) content = modifier(content, { packageDir: pkgDir });
  // Hoist package-unique named exports to the top level. Names a hand-authored
  // `exports.ts` declares are suppressed so that file stays authoritative.
  const customPath = join(pkgDir, CUSTOM_EXPORTS_FILE);
  const suppress = existsSync(customPath) ? customExportNames(customPath) : new Set<string>();
  content = hoistUniqueExports(content, pkgDir, suppress);
  // A sibling `exports.ts` overrides/extends the generated barrel and wins on conflict.
  content = mergeCustomExports(content, pkgDir);

  // barrelsby regenerates on every source edit, but the barrel only *changes* when
  // its set of exporting modules does. If the stamped result matches what's already
  // on disk, restore the read-only bit we cleared above and report no change (0) -
  // this is what keeps the watcher quiet on ordinary in-file edits.
  const next = `${header(BARREL_HEADER)}\n${content}`;
  if (before === next) {
    makeReadonly(rootBarrel);
    return 0;
  }

  writeFileSync(rootBarrel, content);
  stampGenerated(rootBarrel, BARREL_HEADER);
  return 1;
}

/**
 * Rebuild barrels for the given package dirs (default: every package recorded in
 * `pnpm-workspace.yaml` - the source of truth, read via `workspacePackages()`).
 * Returns the number of barrels whose contents actually changed (an unchanged
 * export surface is a no-op), so callers can stay quiet when nothing moved.
 */
export function generateBarrels(opts: { dirs?: string[]; modifier?: BarrelModifier } = {}): number {
  const dirs = opts.dirs ?? workspacePackages().map((p) => p.dir);
  let total = 0;
  for (const dir of dirs) total += generateForPackage(dir, opts.modifier);
  return total;
}
