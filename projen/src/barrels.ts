/**
 * Barrel generator.
 *
 * For every package it writes the package-root `index.ts` plus generated
 * `src/**​/index.ts` subpath barrels when the package enables the generated
 * nested export pattern. The root keeps its existing direct module
 * namespaces; nested barrels expose each directory as
 * `@scope/package/<directory>`. Both follow the same rules (see
 * {@link isExcluded}):
 *   1. a file/folder whose name starts with `_` is private and never barrelled;
 *   2. test / `.d.ts` files are skipped;
 *   3. a hand-authored `src/**​/index.ts` is a subpath entry, while a generated
 *      nested index is the facade for its generated folder;
 *   4. only files that actually contain an `export` are re-exported.
 *
 * A hand-authored `exports.ts` sitting next to any generated `index.ts` (a
 * Vite-style override) is spliced in last and wins: its exports are appended,
 * and any generated `export * as <ns>` whose namespace it also declares is
 * dropped so the custom one takes priority. This keeps barrels auto-generated
 * while letting you add or override individual exports at every depth.
 *
 *
 * Each eligible module becomes `export * as <name>` from its barrel-relative
 * path (camelCase namespace from its path segments; invalid identifiers
 * suffixed with `Module`), sorted by module path.
 *
 * On top of the namespace lines, every export that is UNIQUE across the package
 * (declared in exactly one module) is also HOISTED to the barrel's top level, so
 * consumers can write `GenieMessage` or `DBXToolsNodeProject` instead of
 * `genieModel.GenieMessage` / `project.DBXToolsNodeProject`. Types go out as
 * `export type { ... }` (required under `isolatedModules`), values as
 * `export { ... }`. The module namespaces stay either way, so a namespaced call
 * site keeps working.
 *
 * The package-root barrel also exports `PACKAGE_IDENTIFIER` and
 * `PACKAGE_VERSION` from the package's own `package.json`.
 *
 * Uniqueness is tallied over types and values TOGETHER: a name carried by two
 * modules is ambiguous whichever kind it is, and hoisting one module's value
 * beside another's same-named type would emit two conflicting re-exports. Such a
 * name stays namespace-only. Names that collide with a generated namespace, or
 * that a hand-authored `exports.ts` declares, are never hoisted (that file wins).
 *
 * One collision is NOT ambiguous, though: a HAND-WRITTEN module and a GENERATED
 * one (a codegen `src/` module, recognised by its do-not-edit banner) declaring
 * the same name. The hand-written module is by definition the curated view of the
 * generated shape - `shared-genie`'s `genie-model.ts` extends and re-exports its
 * own generated `dashboards.ts` - so it WINS and its name is still hoisted.
 * Treating that pair as ambiguous is what silently dropped `GenieMessage`,
 * `GenieSpace`, and `MessageStatus` from the barrel the moment the two modules
 * became siblings, breaking every consumer importing them by name.
 *
 * The result gets a do-not-edit header + read-only bit (see `./generated`).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { find } from "@dbx-tools/path";
import { json, stringUtils } from "@dbx-tools/shared-core";
import isIdentifier from "is-identifier";
import { header, isGenerated, makeReadonly, makeWritable, type HeaderOpts } from "./generated.ts";
import { moduleExports, moduleStatements, type ModuleExport } from "./module-exports.ts";
import { isModuleFile, toPosix, recordedPackages, resolveRepoRoot } from "./packages.ts";

/**
 * A `src`-relative posix path excluded from the root barrel:
 *   1. any path segment starting with `_` (private module or folder);
 *   2. a test / spec file;
 *   3. a `.d.ts` declaration;
 *   4. a hand-authored `src/**​/index.ts` - a subpath entry (e.g. `src/react/index.ts`
 *      behind a package's `./react` export), not a module to namespace into the barrel.
 *      Generated nested indexes are retained as the generated folder's facade.
 */
function isExcluded(relPath: string, srcDir: string): boolean {
  return (
    /(^|\/)_/.test(relPath) ||
    /\.(test|spec)\./.test(relPath) ||
    /\.d\.ts$/.test(relPath) ||
    (/(^|\/)index\.ts$/.test(relPath) && !isGenerated(join(srcDir, relPath)))
  );
}

/** Module file extension, for stripping to an extensionless module path. */
const MODULE_EXT_RE = /\.(tsx?|jsx?|mts|cts)$/;

/** True for a TypeScript source file (preferred over a compiled `.js` sibling). */
function isSourceExt(file: string): boolean {
  return /\.(tsx?|mts|cts)$/.test(file);
}

/** Top-level statement types that make a file a re-exportable module. */
const EXPORT_STATEMENT_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "TSExportAssignment",
]);

/** True when the file has at least one top-level export statement. */
function hasExport(file: string): boolean {
  return moduleStatements(file).some((stmt) => EXPORT_STATEMENT_TYPES.has(stmt.type));
}

/**
 * The do-not-edit banner stamped on every generated barrel. Deliberately stable
 * (no timestamp) so a barrel is a pure function of its exporting modules - which
 * is what lets {@link generateForPackage} skip the rewrite when nothing changed.
 */
const BARREL_HEADER: HeaderOpts = {
  tool: "projen watch",
  source: "the exporting modules in ./src",
};

/** Generated package metadata exports, reserved against source-module hoisting. */
const PACKAGE_IDENTIFIER_EXPORT = "PACKAGE_IDENTIFIER";
const PACKAGE_IDENTIFIER_LINE = `export const ${PACKAGE_IDENTIFIER_EXPORT} = "";`;
const PACKAGE_IDENTIFIER_LINE_RE = /^export const PACKAGE_IDENTIFIER = .*;$/m;
const PACKAGE_VERSION_EXPORT = "PACKAGE_VERSION";
const PACKAGE_VERSION_LINE = `export const ${PACKAGE_VERSION_EXPORT} = "";`;
const PACKAGE_VERSION_LINE_RE = /^export const PACKAGE_VERSION = .*;$/m;

/** `config-tools` / `config_tools` -> `configTools`; `local-fs` -> `localFS`. */
function moduleSegmentToCamel(segment: string): string {
  const tokens = [
    ...stringUtils.tokenizeWithOptions({ lowerCase: true, capitalize: true }, segment),
  ];
  if (tokens.length === 0) return segment;
  const first = tokens[0]!;
  const rest = tokens.slice(1);
  // Standalone acronym modules (`fs`, `ai`) stay lowercase so they match
  // Node-style namespaces (`import * as fs`). Trailing / mid acronyms keep
  // their override casing (`localFS`).
  const head =
    rest.length === 0 && first === first.toUpperCase()
      ? first.toLowerCase()
      : first.charAt(0).toLowerCase() + first.slice(1);
  return head + rest.join("");
}

/** Derive a valid namespace identifier from a barrel-relative module path. */
function modulePathToNamespace(modulePath: string): string {
  const rel = modulePath
    .replace(/^\.\//, "")
    .replace(/^src\//, "")
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  const segments = rel.split("/");
  if (segments.at(-1) === "index" && segments.length > 1) segments.pop();
  const names = segments.map(moduleSegmentToCamel);
  let name =
    names.length === 1
      ? names[0]!
      : names[0]! +
        names
          .slice(1)
          .map((s) => stringUtils.capitalize(s))
          .join("");
  if (!isIdentifier(name)) {
    name = `${name}Module`;
  }
  return name;
}

/** A relative module path parsed out of a generated `export * as <ns>` line. */
function namespaceLines(content: string): { ns: string; modulePath: string }[] {
  const out: { ns: string; modulePath: string }[] = [];
  for (const line of content.split("\n")) {
    const match = /^export \* as (\w+) from "(\.\/.+)";\s*$/.exec(line);
    if (match) out.push({ ns: match[1]!, modulePath: match[2]! });
  }
  return out;
}

/**
 * Append hoisted top-level re-exports for every export that is UNIQUE across the
 * package's modules - `export type { ... }` for types, `export { ... }` for
 * non-function values (classes, consts, enums, …). `export function` names are
 * never hoisted; they stay namespace-only (`posixPath.toPosix`). A name declared
 * by two or more modules is ambiguous and left namespace-only - UNLESS exactly one
 * of them is hand-written and the rest are generated, in which case the
 * hand-written module owns the name (see the module doc). `suppress` names (a
 * hand-authored `exports.ts` surface) are never hoisted so that file stays
 * authoritative.
 */
function hoistUniqueExports(content: string, barrelDir: string, suppress: Set<string>): string {
  const namespaces = namespaceLines(content);
  if (namespaces.length === 0) return content;

  // A hoisted name must never collide with a generated `export * as <ns>`
  // namespace (e.g. a `mixin.ts` exporting a `mixin` value alongside the
  // `export * as mixin` line), so treat every namespace id as suppressed too.
  const blocked = new Set<string>(suppress);
  for (const { ns } of namespaces) blocked.add(ns);

  // Uniqueness is tallied over hoistable types AND values together - name ->
  // { count, owning module }. Functions are excluded from hoisting and from
  // this tally so they do not block a same-named type/class in another module.
  //
  // A generated module never claims a name a hand-written sibling also declares:
  // it is counted only while no hand-written module owns the name, and it yields
  // ownership as soon as one does. So a curated re-export
  // (`genie-model.ts`'s `GenieMessage`, extending generated `dashboards.ts`)
  // stays hoisted, while two HAND-WRITTEN modules claiming one name are still
  // ambiguous and stay namespace-only.
  const seen = new Map<string, { count: number; modulePath: string; generated: boolean }>();
  const perModule = new Map<string, ModuleExport[]>();
  for (const { modulePath } of namespaces) {
    const file = join(barrelDir, modulePath.replace(/^\.\//, ""));
    const exports = moduleExports(file).filter((e) => !e.isFunction);
    perModule.set(modulePath, exports);
    const generated = isGenerated(file);
    for (const { name } of exports) {
      const prior = seen.get(name);
      if (!prior) {
        seen.set(name, { count: 1, modulePath, generated });
        continue;
      }
      // Hand-written beats generated, either direction, without counting as a clash.
      if (prior.generated !== generated) {
        if (prior.generated) seen.set(name, { count: 1, modulePath, generated });
        continue;
      }
      prior.count += 1;
    }
  }

  const lines: string[] = [];
  for (const { modulePath } of namespaces) {
    const types: string[] = [];
    const values: string[] = [];
    for (const { name, isType } of perModule.get(modulePath) ?? []) {
      if (blocked.has(name)) continue;
      const entry = seen.get(name);
      // Unique across the package AND this is the module that owns it.
      if (!entry || entry.count !== 1 || entry.modulePath !== modulePath) continue;
      (isType ? types : values).push(name);
    }
    if (values.length) lines.push(`export { ${values.join(", ")} } from "${modulePath}";`);
    if (types.length) lines.push(`export type { ${types.join(", ")} } from "${modulePath}";`);
  }
  if (lines.length === 0) return content;
  return `${content.replace(/\n+$/, "")}\n${lines.join("\n")}\n`;
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
  const body = moduleStatements(file) as ReadonlyArray<Record<string, any>>;
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
function mergeCustomExports(content: string, barrelDir: string): string {
  const customPath = join(barrelDir, CUSTOM_EXPORTS_FILE);
  if (!existsSync(customPath)) return content;
  const overridden = customExportNames(customPath);
  const kept = content.split("\n").filter((line) => {
    const ns = /^export \* as (\w+) from /.exec(line)?.[1];
    return !(ns && overridden.has(ns));
  });
  return `${kept.join("\n").replace(/\n+$/, "")}\nexport * from "./exports.ts";\n`;
}

/** Read the authoritative npm package metadata emitted by the package project. */
function packageMetadata(pkgDir: string): {
  identifier: string;
  version: string;
} {
  const manifestPath = join(pkgDir, "package.json");
  const manifest = existsSync(manifestPath)
    ? json.parseRecord(readFileSync(manifestPath, "utf8"))
    : undefined;
  const name = manifest?.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Cannot generate barrel without package.json name: ${manifestPath}`);
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`Cannot generate barrel without package.json version: ${manifestPath}`);
  }
  return { identifier: name, version };
}

/** Normalize package metadata before comparing the barrel's export structure. */
function withoutPackageMetadata(content: string): string {
  return content
    .replace(PACKAGE_IDENTIFIER_LINE_RE, PACKAGE_IDENTIFIER_LINE)
    .replace(PACKAGE_VERSION_LINE_RE, PACKAGE_VERSION_LINE);
}

/** Resolve and insert package metadata when a barrel is about to be written. */
function withPackageMetadata(content: string, pkgDir: string): string {
  const metadata = packageMetadata(pkgDir);
  return content
    .replace(
      PACKAGE_IDENTIFIER_LINE_RE,
      () => `export const ${PACKAGE_IDENTIFIER_EXPORT} = ${JSON.stringify(metadata.identifier)};`,
    )
    .replace(
      PACKAGE_VERSION_LINE_RE,
      () => `export const ${PACKAGE_VERSION_EXPORT} = ${JSON.stringify(metadata.version)};`,
    );
}

/**
 * True when a generated index belongs to this barrel generator rather than a
 * binding/codegen owner that also uses the repository's generated-file header.
 */
export function isGeneratedBarrel(file: string): boolean {
  return existsSync(file) && readFileSync(file, "utf8").startsWith(header(BARREL_HEADER));
}

/** Public direct modules and child-directory facades for one generated barrel. */
function barrelCandidates(barrelDir: string): string[] {
  const files = [...find.findFiles("*", { cwd: barrelDir })]
    .map(toPosix)
    .filter((file) => !file.includes("/"))
    .filter((file) => file !== "index.ts" && file !== CUSTOM_EXPORTS_FILE)
    .filter((file) => isModuleFile(file))
    .filter((file) => !isExcluded(file, barrelDir))
    .filter((file) => hasExport(join(barrelDir, file)));
  const childIndexes = [...find.findFiles("*/index.ts", { cwd: barrelDir })]
    .map(toPosix)
    .filter((file) => file.split("/").length === 2)
    .filter((file) => !isExcluded(file, barrelDir))
    .filter((file) => hasExport(join(barrelDir, file)));
  return [...files, ...childIndexes];
}

/** Write or remove one generated barrel and return whether its file changed. */
function generateBarrel(
  pkgDir: string,
  barrelDir: string,
  moduleFiles: string[],
  includePackageMetadata: boolean,
): number {
  const barrel = includePackageMetadata ? join(pkgDir, "index.ts") : join(barrelDir, "index.ts");
  if (!includePackageMetadata && existsSync(barrel) && !isGeneratedBarrel(barrel)) return 0;
  const before = existsSync(barrel) ? readFileSync(barrel, "utf8") : undefined;

  const byModulePath = new Map<string, string>();
  for (const file of moduleFiles) {
    const stem = file.replace(/(^|\/)index\.ts$/, "").replace(MODULE_EXT_RE, "");
    const existing = byModulePath.get(stem);
    if (!existing || (!isSourceExt(existing) && isSourceExt(file))) byModulePath.set(stem, file);
  }
  const modulePaths = [...byModulePath.keys()].sort((left, right) => left.localeCompare(right));

  if (modulePaths.length === 0) {
    if (before !== undefined && (includePackageMetadata || isGeneratedBarrel(barrel))) {
      makeWritable(barrel);
      rmSync(barrel, { force: true });
      return includePackageMetadata ? 0 : 1;
    }
    return 0;
  }

  const namespaceExports = modulePaths
    .map((stem) => {
      const prefix = includePackageMetadata ? "./src/" : "./";
      const modulePath = `${prefix}${byModulePath.get(stem)!}`;
      return `export * as ${modulePathToNamespace(modulePath)} from "${modulePath}";`;
    })
    .join("\n");
  let content = includePackageMetadata
    ? `${PACKAGE_IDENTIFIER_LINE}\n${PACKAGE_VERSION_LINE}\n${namespaceExports}`
    : namespaceExports;
  const customDir = includePackageMetadata ? pkgDir : barrelDir;
  const customPath = join(customDir, CUSTOM_EXPORTS_FILE);
  const suppress = existsSync(customPath) ? customExportNames(customPath) : new Set<string>();
  if (includePackageMetadata) {
    suppress.add(PACKAGE_IDENTIFIER_EXPORT);
    suppress.add(PACKAGE_VERSION_EXPORT);
  }
  content = hoistUniqueExports(content, includePackageMetadata ? pkgDir : barrelDir, suppress);
  content = mergeCustomExports(content, customDir);
  content = `${content.replace(/\n+$/, "")}\n`;
  const template = `${header(BARREL_HEADER)}\n${content}`;
  const next = includePackageMetadata ? withPackageMetadata(template, pkgDir) : template;
  const structurallySame = includePackageMetadata
    ? before !== undefined && withoutPackageMetadata(before) === template && before === next
    : before === next;
  if (structurallySame) return 0;

  writeBarrel(barrel, next);
  makeReadonly(barrel);
  return 1;
}

/**
 * Rebuild one package's nested and root barrels. Nested directories are processed
 * deepest-first so a parent can export each child directory through its generated
 * `index.ts`. The package root deliberately continues to export the underlying
 * modules directly, preserving its existing namespaces while adding subpath entrypoints.
 */
function generateForPackage(pkgDir: string): number {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) return 0;

  const sourceFiles = [...find.findFiles("**/*", { cwd: srcDir })]
    .map(toPosix)
    .filter((file) => isModuleFile(file) || /(^|\/)index\.ts$/.test(file));
  const manifest = json.parseRecord(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const exports = manifest?.exports;
  const nestedExportsEnabled =
    exports != null &&
    typeof exports === "object" &&
    !Array.isArray(exports) &&
    (exports as Record<string, unknown>)["./*"] === "./src/*/index.ts";
  const directories = new Set<string>();
  for (const file of sourceFiles) {
    const fileDir = dirname(file);
    if (fileDir === "." || /(^|\/)_[^/]+/.test(fileDir)) continue;
    let current = fileDir;
    while (current !== ".") {
      directories.add(current);
      current = dirname(current);
    }
  }

  let changed = 0;
  const nestedDirectories = [...directories].sort((left, right) => {
    const depth = (value: string): number => value.split("/").length;
    return depth(right) - depth(left) || right.localeCompare(left);
  });
  for (const directory of nestedDirectories) {
    const barrelDir = join(srcDir, directory);
    if (nestedExportsEnabled) {
      changed += generateBarrel(pkgDir, barrelDir, barrelCandidates(barrelDir), false);
    } else {
      const barrel = join(barrelDir, "index.ts");
      if (isGeneratedBarrel(barrel)) {
        makeWritable(barrel);
        rmSync(barrel, { force: true });
        changed += 1;
      }
    }
  }

  const candidates = sourceFiles
    .filter((file) => !isGeneratedBarrel(join(srcDir, file)))
    .filter((file) => !isExcluded(file, srcDir))
    .filter((file) => hasExport(join(srcDir, file)));
  const generatedIndexDirs = new Set(
    candidates
      .filter((file) => /(^|\/)index\.ts$/.test(file) && isGenerated(join(srcDir, file)))
      .map((file) => file.replace(/(^|\/)index\.ts$/, "")),
  );
  const publicCandidates = candidates.filter((file) => {
    if (/(^|\/)index\.ts$/.test(file)) return true;
    return ![...generatedIndexDirs].some((dir) => dir && file.startsWith(`${dir}/`));
  });

  return changed + generateBarrel(pkgDir, srcDir, publicCandidates, true);
}

/**
 * Attempts at unlocking and writing a barrel before giving up. A sibling process
 * can restore the read-only bit between the two.
 */
const WRITE_ATTEMPTS = 3;

/**
 * Unlock a read-only barrel and replace it, retrying on `EACCES`.
 *
 * The unlock cannot be hoisted to the top of {@link generateForPackage}: several
 * processes write barrels concurrently under `sync --watch` (the barrels watcher,
 * and the projenrc watcher's post-synth `generateBarrels()` sweep), so any gap
 * between `makeWritable` and the write is a window in which another process's
 * `makeReadonly` lands and this write fails with
 * `EACCES: permission denied, open '<pkg>/index.ts'`. Keeping the unlock adjacent
 * to the write avoids a gap during export parsing, and a retry absorbs what is
 * left.
 *
 * Do NOT "simplify" this back to a single unlock-then-write: the failure is
 * timing-dependent, so it looks fine until a full-repo sweep runs against a
 * concurrent one.
 */
function writeBarrel(file: string, content: string): void {
  for (let attempt = 1; ; attempt++) {
    makeWritable(file);
    try {
      writeFileSync(file, content);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" || attempt >= WRITE_ATTEMPTS) throw err;
    }
  }
}

/**
 * Rebuild barrels for the given package dirs (default: every package recorded in
 * `pnpm-workspace.yaml` - the source of truth, read via `recordedPackages()`).
 * Returns the number of barrels whose contents actually changed (an unchanged
 * export surface is a no-op), so callers can stay quiet when nothing moved.
 *
 * Every package is attempted even if an earlier one fails, and the failures are
 * re-thrown together as an `AggregateError` naming each package. Letting the first
 * failure propagate instead abandoned every package after it in the iteration
 * order, so one unwritable barrel silently left the rest of the repo stale with
 * nothing in the log to say which packages had been skipped.
 */
export function generateBarrels(
  opts: { dirs?: string[]; includeRoot?: boolean; projectRoot?: string } = {},
): number {
  const projectRoot = opts.projectRoot ?? resolveRepoRoot();
  const dirs = opts.dirs ?? [
    ...(opts.includeRoot ? [projectRoot] : []),
    ...recordedPackages(projectRoot).map((p) => p.dir),
  ];
  let total = 0;
  const failures: { dir: string; err: unknown }[] = [];
  for (const dir of dirs) {
    try {
      total += generateForPackage(dir);
    } catch (err) {
      failures.push({ dir, err });
    }
  }
  if (failures.length) {
    const names = failures.map((f) => relative(projectRoot, f.dir) || f.dir);
    throw new AggregateError(
      failures.map((f) => f.err),
      `${stringUtils.pluralize(failures.length, "barrel")} failed: ${names.join(", ")}`,
    );
  }
  return total;
}
