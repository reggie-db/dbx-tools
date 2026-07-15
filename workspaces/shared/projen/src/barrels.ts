/**
 * Barrel generator, driven by barrelsby.
 *
 * For every package it writes a single `index.ts` **at the package root** (above
 * `src/`) that namespace-re-exports every module under `src/`, subject to two rules:
 *   1. a file/folder whose name starts with `_` is private and never barrelled;
 *   2. only files that actually contain an `export` are re-exported.
 *
 * barrelsby emits flat `export * from "./x"` lines; we relocate the barrel to
 * `<pkg>/index.ts`, deepen paths (`./x` -> `./src/x`), then rewrite each line to
 * `export * as <name> from "./src/x"` (kebab-case and reserved words sanitized).
 * The result gets an optional caller {@link BarrelModifier}, then a do-not-edit
 * header + read-only bit (see `./generated`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { header, makeReadonly, makeWritable, stampGenerated, type HeaderOpts } from "./generated";
import { logger } from "dbx-tools/log";
import {
  escapeRegExp,
  hasExport,
  isModuleFile,
  repoRoot,
  toPosix,
  walkFiles,
  workspacePackages,
} from "./workspace";

const log = logger.withTag("projen:barrels");
const require = createRequire(import.meta.url);

// barrelsby is CLI-only (its package `main` is missing), so run its bin with node.
// Resolved lazily (not at module load) so importing this module during synth does
// not require barrelsby to be installed yet.
let barrelsbyCli: string | undefined;
function barrelsbyBin(): string {
  return (barrelsbyCli ??= require.resolve("barrelsby/bin/cli.js"));
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

const RESERVED_NAMESPACE_NAMES = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "enum",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
]);

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
  if (!/^[A-Za-z_$][\w$]*$/.test(name) || RESERVED_NAMESPACE_NAMES.has(name)) {
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
      const modulePath = match[2];
      const ns = modulePathToNamespace(modulePath);
      return `export * as ${ns} from "${modulePath}";`;
    })
    .join("\n");
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
  const noExport = walkFiles(srcDir)
    .filter(isModuleFile)
    .filter((f) => !hasExport(f))
    .map((f) => `${escapeRegExp(toPosix(relative(srcDir, f)))}$`);

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
  try {
    execFileSync(process.execPath, args, { cwd: repoRoot, stdio: "pipe" });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? `${(err as { stderr?: Buffer }).stderr ?? ""}`
        : "";
    log.error(`barrelsby failed for ${toPosix(relative(repoRoot, srcDir))}`, stderr);
    throw err;
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
