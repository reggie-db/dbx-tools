/**
 * Barrel generator.
 *
 * For every package it writes a single `index.ts` **at the package root** (above
 * `src/`) that namespace-re-exports every module under `src/`, subject to a few
 * rules (see {@link isExcluded}):
 *   1. a file/folder whose name starts with `_` is private and never barrelled;
 *   2. test / `.d.ts` files are skipped;
 *   3. a hand-authored `src/**​/index.ts` is a subpath entry, while a generated
 *      nested index is the facade for its generated folder;
 *   4. only files that actually contain an `export` are re-exported.
 *
 * A hand-authored `exports.ts` sitting next to the generated `index.ts` (a Vite-style
 * override) is spliced in last and wins: its exports are appended, and any generated
 * `export * as <ns>` whose namespace it also declares is dropped so the custom one
 * takes priority. This keeps the barrel auto-generated while letting you add or
 * override individual exports.
 *
 * A UniFFI source triplet (`bindings.ts`, `_bindings.ts`, and
 * `_bindings-ffi.ts`) is one special case: the internal underscore modules stay
 * private, while `bindings.ts` is re-exported directly instead of under a
 * `bindings` namespace. Generation fails when one of those direct binding names
 * conflicts with another top-level package export.
 *
 * Each eligible module becomes `export * as <name> from "./src/x.ts"` (camelCase
 * namespace from its path segments; invalid identifiers suffixed with `Module`),
 * sorted by module path.
 *
 * On top of the namespace lines, every export that is UNIQUE across the package
 * (declared in exactly one module) is also HOISTED to the barrel's top level, so
 * consumers can write `GenieMessage` or `DBXToolsNodeProject` instead of
 * `genieModel.GenieMessage` / `project.DBXToolsNodeProject`. Types go out as
 * `export type { ... }` (required under `isolatedModules`), values as
 * `export { ... }`. The module namespaces stay either way, so a namespaced call
 * site keeps working.
 *
 * Every generated barrel also exports `PACKAGE_IDENTIFIER` and
 * `PACKAGE_VERSION` from the package's own `package.json`. Runtime helpers can
 * retain package identity without trying to recover it from an ESM namespace
 * object or loader function.
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
import { join, relative } from "node:path";
import { find } from "@dbx-tools/path";
import { json, string } from "@dbx-tools/shared-core";
import isIdentifier from "is-identifier";
import { header, isGenerated, makeReadonly, makeWritable, type HeaderOpts } from "./generated.ts";
import { moduleExports, moduleStatements, type ModuleExport } from "./module-exports.ts";
import { isModuleFile, toPosix, recordedPackages, repoRoot } from "./packages.ts";

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
const PACKAGE_VERSION_EXPORT = "PACKAGE_VERSION";
const PACKAGE_IDENTIFIER_LINE = `export const ${PACKAGE_IDENTIFIER_EXPORT} = "";`;
const PACKAGE_VERSION_LINE = `export const ${PACKAGE_VERSION_EXPORT} = "";`;
const PACKAGE_IDENTIFIER_LINE_RE = /^export const PACKAGE_IDENTIFIER = .*;$/m;
const PACKAGE_VERSION_LINE_RE = /^export const PACKAGE_VERSION = .*;$/m;
const UNIFFI_BINDINGS_FILE = "bindings.ts";
const UNIFFI_GENERATED_FILE = "_bindings.ts";
const UNIFFI_FFI_FILE = "_bindings-ffi.ts";

/** `pnpm-workspace` -> `pnpmWorkspace`; `local-fs` -> `localFS` (`fs` -> `FS`). */
function kebabToCamel(segment: string): string {
  const tokens = [...string.tokenizeWithOptions({ lowerCase: true, capitalize: true }, segment)];
  if (tokens.length === 0) return segment;
  const [first, ...rest] = tokens;
  // Standalone acronym modules (`fs`, `ai`) stay lowercase so they match
  // Node-style namespaces (`import * as fs`). Trailing / mid acronyms keep
  // their override casing (`localFS`).
  const head =
    rest.length === 0 && first === first.toUpperCase()
      ? first.toLowerCase()
      : first.charAt(0).toLowerCase() + first.slice(1);
  return head + rest.join("");
}

/** Derive a valid namespace identifier from a relocated barrel module path. */
function modulePathToNamespace(modulePath: string): string {
  const rel = modulePath.replace(/^\.\/src\//, "").replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  const segments = rel.split("/");
  if (segments.at(-1) === "index" && segments.length > 1) segments.pop();
  const names = segments.map(kebabToCamel);
  let name =
    names.length === 1
      ? names[0]!
      : names[0]! +
        names
          .slice(1)
          .map((s) => string.capitalize(s))
          .join("");
  if (!isIdentifier(name)) {
    name = `${name}Module`;
  }
  return name;
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
function hoistUniqueExports(content: string, pkgDir: string, suppress: Set<string>): string {
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
    const file = join(pkgDir, modulePath.replace(/^\.\//, ""));
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
function mergeCustomExports(content: string, pkgDir: string): string {
  const customPath = join(pkgDir, CUSTOM_EXPORTS_FILE);
  if (!existsSync(customPath) || isLegacyBindingsExport(customPath)) return content;
  const overridden = customExportNames(customPath);
  const kept = content.split("\n").filter((line) => {
    const ns = /^export \* as (\w+) from /.exec(line)?.[1];
    return !(ns && overridden.has(ns));
  });
  return `${kept.join("\n").replace(/\n+$/, "")}\nexport * from "./exports.ts";\n`;
}

function isLegacyBindingsExport(file: string): boolean {
  return readFileSync(file, "utf8").trim() === 'export * from "./src/bindings.ts";';
}

function hasUniFFIBindings(srcDir: string): boolean {
  return [UNIFFI_BINDINGS_FILE, UNIFFI_GENERATED_FILE, UNIFFI_FFI_FILE].every((file) =>
    existsSync(join(srcDir, file)),
  );
}

function bindingExportNames(srcDir: string): Set<string> {
  return new Set(
    [UNIFFI_BINDINGS_FILE, UNIFFI_GENERATED_FILE].flatMap((file) =>
      moduleExports(join(srcDir, file)).map((entry) => entry.name),
    ),
  );
}

function barrelExportNames(content: string, customPath: string): Set<string> {
  const names = new Set<string>([PACKAGE_IDENTIFIER_EXPORT, PACKAGE_VERSION_EXPORT]);
  for (const match of content.matchAll(/^export \* as (\w+) from /gm)) {
    names.add(match[1]!);
  }
  for (const match of content.matchAll(/^export(?: type)? \{([^}]+)\} from /gm)) {
    for (const specifier of match[1]!.split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const name = parts.at(-1);
      if (name) names.add(name);
    }
  }
  if (existsSync(customPath) && !isLegacyBindingsExport(customPath)) {
    const statements = moduleStatements(customPath) as ReadonlyArray<{
      type: string;
      exported?: unknown;
    }>;
    if (
      statements.some(
        (statement) => statement.type === "ExportAllDeclaration" && !statement.exported,
      )
    ) {
      throw new Error(
        `Cannot verify UniFFI export conflicts through a bare export in ${customPath}`,
      );
    }
    for (const name of customExportNames(customPath)) names.add(name);
  }
  return names;
}

function assertNoBindingExportConflicts(srcDir: string, content: string, customPath: string): void {
  const other = barrelExportNames(content, customPath);
  const conflicts = [...bindingExportNames(srcDir)].filter((name) => other.has(name)).sort();
  if (conflicts.length > 0) {
    throw new Error(
      `UniFFI binding exports conflict with package exports in ${srcDir}: ${conflicts.join(", ")}`,
    );
  }
}

/** Read the authoritative npm package name and version emitted by the package project. */
function packageMetadata(pkgDir: string): { identifier: string; version: string } {
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
 * Rebuild one package's root barrel. Returns 1 only if the barrel's contents
 * actually changed - a module was added, removed, renamed, or toggled its
 * `export` - and 0 for a no-op. An edit *inside* an already-exported module (even
 * adding a new named export) leaves the namespace `export * as … from "./src/x"`
 * list identical, so it is a no-op.
 */
function generateForPackage(pkgDir: string): number {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) return 0;

  const rootBarrel = join(pkgDir, "index.ts");
  // Snapshot the current barrel so we can tell a real change (module added/removed/
  // renamed) from an edit *inside* an already-exported module, which leaves the
  // `export * as … from "./src/x"` list - and therefore this file - byte-for-byte
  // identical.
  const before = existsSync(rootBarrel) ? readFileSync(rootBarrel, "utf8") : undefined;

  // The re-exportable module set under `src/`: every source file that actually
  // exports something, minus private / test / declaration files and hand-authored
  // `src/**/index.ts` subpath entries. A generated nested index is retained as
  // that generated folder's public facade. `findFiles`
  // yields posix paths relative to `srcDir`; `hasExport` parses each via
  // `moduleStatements` and needs the absolute path.
  const candidates = [...find.findFiles("**/*", { cwd: srcDir })]
    .map(toPosix)
    .filter(
      (file) =>
        isModuleFile(file) || (/(^|\/)index\.ts$/.test(file) && isGenerated(join(srcDir, file))),
    )
    .filter((f) => !isExcluded(f, srcDir))
    .filter((f) => hasExport(join(srcDir, f)));

  const generatedIndexDirs = new Set(
    candidates
      .filter((file) => /(^|\/)index\.ts$/.test(file) && isGenerated(join(srcDir, file)))
      .map((file) => file.replace(/(^|\/)index\.ts$/, "")),
  );
  const publicCandidates = candidates.filter((file) => {
    if (/(^|\/)index\.ts$/.test(file)) return true;
    return ![...generatedIndexDirs].some((dir) => dir && file.startsWith(`${dir}/`));
  });

  // Collapse each extensionless module path to one entry, preferring a TypeScript
  // source over a sibling compiled artifact (`math.ts` wins over a committed
  // `math.js`), so a module is barrelled exactly once. Then sort by module path.
  const byModulePath = new Map<string, string>();
  for (const f of publicCandidates) {
    const stem = f.replace(/(^|\/)index\.ts$/, "").replace(MODULE_EXT_RE, "");
    const existing = byModulePath.get(stem);
    if (!existing || (!isSourceExt(existing) && isSourceExt(f))) byModulePath.set(stem, f);
  }
  const modulePaths = [...byModulePath.keys()].sort((a, b) => a.localeCompare(b));
  const uniffiBindings = hasUniFFIBindings(srcDir);
  const namespacedModulePaths = uniffiBindings
    ? modulePaths.filter((modulePath) => modulePath !== "bindings")
    : modulePaths;

  // No eligible modules -> no barrel: drop any stale root barrel and bail.
  if (modulePaths.length === 0) {
    if (existsSync(rootBarrel)) {
      makeWritable(rootBarrel);
      rmSync(rootBarrel, { force: true });
    }
    return 0;
  }

  // `./src/<path>` with the module's REAL extension, namespaced by its path
  // segments (camelCase; invalid identifiers suffixed with `Module`). The
  // extension is written because `tsc` rewrites it on emit
  // (`rewriteRelativeImportExtensions`) - an extensionless specifier would be
  // copied through verbatim and Node's ESM resolver cannot probe for it.
  const namespaceExports = namespacedModulePaths
    .map((stem) => {
      const modulePath = `./src/${byModulePath.get(stem)!}`;
      return `export * as ${modulePathToNamespace(modulePath)} from "${modulePath}";`;
    })
    .join("\n");
  let content = `${PACKAGE_IDENTIFIER_LINE}\n${PACKAGE_VERSION_LINE}\n${namespaceExports}`;
  // Hoist package-unique named exports to the top level. Names a hand-authored
  // `exports.ts` declares are suppressed so that file stays authoritative.
  const customPath = join(pkgDir, CUSTOM_EXPORTS_FILE);
  const suppress =
    existsSync(customPath) && !isLegacyBindingsExport(customPath)
      ? customExportNames(customPath)
      : new Set<string>();
  suppress.add(PACKAGE_IDENTIFIER_EXPORT);
  suppress.add(PACKAGE_VERSION_EXPORT);
  content = hoistUniqueExports(content, pkgDir, suppress);
  // A sibling `exports.ts` overrides/extends the generated barrel and wins on conflict.
  content = mergeCustomExports(content, pkgDir);
  if (uniffiBindings) {
    assertNoBindingExportConflicts(srcDir, content, customPath);
    content = content.replace(
      PACKAGE_VERSION_LINE,
      `${PACKAGE_VERSION_LINE}\nexport * from "./src/bindings.ts";`,
    );
  }

  // Package metadata is blanked for the structural comparison, then restored
  // from package.json so a version-only change still rewrites the barrel.
  // If the structural result and package metadata match what's on disk, leave
  // the file and its read-only bit untouched and report no change (0). This
  // keeps the watcher quiet on ordinary in-file edits while allowing a version
  // bump to update PACKAGE_VERSION.
  content = `${content.replace(/\n+$/, "")}\n`;
  const template = `${header(BARREL_HEADER)}\n${content}`;
  const next = withPackageMetadata(template, pkgDir);
  if (before !== undefined && withoutPackageMetadata(before) === template && before === next) {
    return 0;
  }

  // Written whole (header included) rather than via `stampGenerated`, which would
  // re-read and rewrite the file to prepend the same header - a second write, and
  // therefore a second window in which the read-only bit can come back. `next` is
  // byte-for-byte what the comparison above accepted, so the two cannot drift.
  writeBarrel(rootBarrel, next);
  makeReadonly(rootBarrel);
  return 1;
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
 * `EACCES: permission denied, open '<pkg>/index.ts'`. The gap used to span all of
 * the oxc parsing done for export hoisting, which made it wide enough to hit
 * routinely. Keeping the unlock adjacent to the write shrinks it to nothing much,
 * and a retry absorbs what is left.
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
export function generateBarrels(opts: { dirs?: string[] } = {}): number {
  const dirs = opts.dirs ?? recordedPackages().map((p) => p.dir);
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
    const names = failures.map((f) => relative(repoRoot, f.dir) || f.dir);
    throw new AggregateError(
      failures.map((f) => f.err),
      `${string.pluralize(failures.length, "barrel")} failed: ${names.join(", ")}`,
    );
  }
  return total;
}
