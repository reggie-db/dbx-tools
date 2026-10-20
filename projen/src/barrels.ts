/**
 * Generate one namespace-only package barrel plus one root-level barrel for
 * every public source folder.
 *
 * `src/auth/react/gate.ts` contributes to `index.ts`, `index.auth.ts`, and
 * `index.auth.react.ts`. Package export maps point folder subpaths at those root
 * files. Source folders never contain generated `index.ts` files, and
 * individual modules never receive package subpaths.
 *
 * Every output is stamped and read-only.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findFilesSync } from "@dbx-tools/path";
import { parseRecord, tokenizeWithOptions, capitalize, pluralize } from "@dbx-tools/shared-core";
import isIdentifier from "is-identifier";
import { header, isGenerated, makeReadonly, makeWritable, type HeaderOpts } from "./generated.ts";
import { moduleExports, moduleStatements, type ModuleExport } from "./module-exports.ts";
import { isModuleFile, toPosix, recordedPackages, resolveRepoRoot } from "./packages.ts";

/** Whether a source-relative module is private, test-only, declared, or an index. */
function isExcluded(relPath: string): boolean {
  return (
    /(^|\/)_/.test(relPath) ||
    /\.(test|spec)\./.test(relPath) ||
    /\.d\.ts$/.test(relPath) ||
    /(^|\/)index\.(?:tsx?|jsx?|mts|cts)$/.test(relPath)
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

/** Generated package metadata exports. */
const PACKAGE_IDENTIFIER_EXPORT = "PACKAGE_IDENTIFIER";
const PACKAGE_IDENTIFIER_LINE = `export const ${PACKAGE_IDENTIFIER_EXPORT} = "";`;
const PACKAGE_IDENTIFIER_LINE_RE = /^export const PACKAGE_IDENTIFIER = .*;$/m;
const PACKAGE_VERSION_EXPORT = "PACKAGE_VERSION";
const PACKAGE_VERSION_LINE = `export const ${PACKAGE_VERSION_EXPORT} = "";`;
const PACKAGE_VERSION_LINE_RE = /^export const PACKAGE_VERSION = .*;$/m;

/** `config-tools` / `config_tools` -> `configTools`; `local-fs` -> `localFS`. */
function moduleSegmentToCamel(segment: string): string {
  const tokens = [...tokenizeWithOptions({ lowerCase: true, capitalize: true }, segment)];
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
          .map((s) => capitalize(s))
          .join("");
  if (!isIdentifier(name)) {
    name = `${name}Module`;
  }
  return name;
}

/** Relative modules parsed from generated namespace exports. */
function namespaceLines(content: string): { ns: string; modulePath: string }[] {
  const out: { ns: string; modulePath: string }[] = [];
  for (const line of content.split("\n")) {
    const match = /^export \* as (\w+) from "(\.\/.+)";\s*$/.exec(line);
    if (match) out.push({ ns: match[1]!, modulePath: match[2]! });
  }
  return out;
}

/** Append flat exports for names owned by exactly one module. */
function hoistUniqueExports(
  content: string,
  barrelDir: string,
  modulePaths: readonly string[],
  reserved: Set<string>,
): string {
  const namespaces = namespaceLines(content);

  const blocked = new Set(reserved);
  for (const { ns } of namespaces) blocked.add(ns);

  const seen = new Map<string, { count: number; modulePath: string; generated: boolean }>();
  const perModule = new Map<string, ModuleExport[]>();
  for (const modulePath of modulePaths) {
    if (!modulePath.startsWith("./src/")) continue;
    const file = join(barrelDir, modulePath.replace(/^\.\//, ""));
    const exports = moduleExports(file);
    perModule.set(modulePath, exports);
    const generated = isGenerated(file);
    for (const { name } of exports) {
      const prior = seen.get(name);
      if (!prior) {
        seen.set(name, { count: 1, modulePath, generated });
        continue;
      }
      if (prior.generated !== generated) {
        if (prior.generated) seen.set(name, { count: 1, modulePath, generated });
        continue;
      }
      prior.count += 1;
    }
  }

  const lines: string[] = [];
  for (const modulePath of modulePaths) {
    const types: string[] = [];
    const values: string[] = [];
    for (const { name, isType } of perModule.get(modulePath) ?? []) {
      if (blocked.has(name)) continue;
      const entry = seen.get(name);
      if (!entry || entry.count !== 1 || entry.modulePath !== modulePath) continue;
      (isType ? types : values).push(name);
    }
    if (values.length) lines.push(`export { ${values.join(", ")} } from "${modulePath}";`);
    if (types.length) lines.push(`export type { ${types.join(", ")} } from "${modulePath}";`);
  }
  if (lines.length === 0) return content;
  return `${content.replace(/\n+$/, "")}\n${lines.join("\n")}`;
}

/** Read the authoritative npm package metadata emitted by the package project. */
function packageMetadata(pkgDir: string): {
  identifier: string;
  version: string;
} {
  const manifestPath = join(pkgDir, "package.json");
  const manifest = existsSync(manifestPath)
    ? parseRecord(readFileSync(manifestPath, "utf8"))
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

interface BarrelModule {
  readonly specifier: string;
  readonly namespacePath: string;
  readonly reexport: boolean;
}

/** Root-level barrel filename for one source-relative folder. */
export function folderBarrelFile(directory: string): string {
  return `index.${toPosix(directory).replaceAll("/", ".")}.ts`;
}

/** Write or remove one generated barrel and return whether its file changed. */
function generateBarrel(
  pkgDir: string,
  barrel: string,
  modules: readonly BarrelModule[],
  includePackageMetadata: boolean,
): number {
  const beforeStat = statSync(barrel, { throwIfNoEntry: false });
  if (beforeStat && !isGeneratedBarrel(barrel)) {
    throw new Error(`Generated barrel path is owned by a hand-written file: ${barrel}`);
  }
  const before = beforeStat ? readFileSync(barrel, "utf8") : undefined;

  const bySourceStem = new Map<string, BarrelModule>();
  for (const module of modules) {
    const stem = module.specifier.replace(MODULE_EXT_RE, "");
    const existing = bySourceStem.get(stem);
    if (!existing || (!isSourceExt(existing.specifier) && isSourceExt(module.specifier))) {
      bySourceStem.set(stem, module);
    }
  }
  const selected = [...bySourceStem.values()].sort((left, right) =>
    left.specifier.localeCompare(right.specifier),
  );

  if (selected.length === 0) {
    if (!includePackageMetadata && before !== undefined) {
      makeWritable(barrel);
      rmSync(barrel, { force: true });
      return 1;
    }
    if (!includePackageMetadata) return 0;
  }

  const exportedNames = new Set(
    selected.flatMap(({ specifier }) =>
      moduleExports(join(pkgDir, specifier.replace(/^\.\//, ""))).map(({ name }) => name),
    ),
  );
  const namespaceExports = selected.flatMap(({ specifier, namespacePath, reexport }) => {
    const namespace = modulePathToNamespace(`./${namespacePath}`);
    return [
      ...(exportedNames.has(namespace) ? [] : [`export * as ${namespace} from "${specifier}";`]),
      ...(reexport ? [`export * from "${specifier}";`] : []),
    ];
  });
  let content = includePackageMetadata
    ? `${PACKAGE_IDENTIFIER_LINE}\n${PACKAGE_VERSION_LINE}\n${namespaceExports.join("\n")}`
    : namespaceExports.join("\n");
  content = hoistUniqueExports(
    content,
    pkgDir,
    selected.map(({ specifier }) => specifier),
    new Set(includePackageMetadata ? [PACKAGE_IDENTIFIER_EXPORT, PACKAGE_VERSION_EXPORT] : []),
  );
  const template = `${header(BARREL_HEADER)}\n${content.replace(/\n+$/, "")}\n`;
  const next = includePackageMetadata ? withPackageMetadata(template, pkgDir) : template;
  const structurallySame = includePackageMetadata
    ? before !== undefined && withoutPackageMetadata(before) === template && before === next
    : before === next;
  if (structurallySame) {
    if (beforeStat && (beforeStat.mode & 0o777) !== 0o444) makeReadonly(barrel);
    return 0;
  }

  writeBarrel(barrel, next);
  makeReadonly(barrel);
  return 1;
}

function removeGeneratedBarrel(file: string): number {
  if (!isGeneratedBarrel(file)) return 0;
  makeWritable(file);
  rmSync(file, { force: true });
  return 1;
}

/** Rebuild one package's root and folder barrels. */
function generateForPackage(pkgDir: string): number {
  const srcDir = join(pkgDir, "src");
  if (!existsSync(srcDir)) {
    return generateBarrel(pkgDir, join(pkgDir, "index.ts"), [], true);
  }

  const discoveredFiles = [...findFilesSync("**/*", { cwd: srcDir })].map(toPosix);
  const nestedIndexes = discoveredFiles.filter((file) =>
    /(^|\/)index\.(?:tsx?|jsx?|mts|cts)$/.test(file),
  );
  for (const index of nestedIndexes) {
    const path = join(srcDir, index);
    if (!isGeneratedBarrel(path)) {
      throw new Error(`Nested source index is unsupported: ${path}`);
    }
  }

  let changed = nestedIndexes.reduce(
    (count, index) => count + removeGeneratedBarrel(join(srcDir, index)),
    0,
  );
  const sourceFiles = discoveredFiles
    .filter((file) => isModuleFile(file))
    .filter((file) => !isExcluded(file))
    .filter((file) => hasExport(join(srcDir, file)));
  const directories = new Set<string>();
  for (const file of sourceFiles) {
    const fileDir = dirname(file);
    if (fileDir === "." || /(^|\/)_[^/]+/.test(fileDir)) continue;
    directories.add(fileDir);
  }

  const folderBarrels = new Set([...directories].map(folderBarrelFile));
  for (const file of [...findFilesSync("index.*.ts", { cwd: pkgDir })].map(toPosix)) {
    if (file.includes("/") || file.endsWith(".d.ts") || folderBarrels.has(file)) continue;
    const path = join(pkgDir, file);
    if (!isGeneratedBarrel(path)) {
      throw new Error(`Folder barrel path is owned by a hand-written file: ${path}`);
    }
    changed += removeGeneratedBarrel(path);
  }

  const rootModules = sourceFiles
    .filter((source) => dirname(source) === ".")
    .map((source) => ({
      specifier: `./src/${source}`,
      namespacePath: source,
      reexport: moduleExports(join(srcDir, source)).length === 0,
    }));
  changed += generateBarrel(pkgDir, join(pkgDir, "index.ts"), rootModules, true);

  for (const directory of [...directories].sort((left, right) => left.localeCompare(right))) {
    const modules: BarrelModule[] = sourceFiles
      .filter((source) => dirname(source) === directory)
      .map((source) => ({
        specifier: `./src/${source}`,
        namespacePath: source.slice(directory.length + 1),
        reexport: moduleExports(join(srcDir, source)).length === 0,
      }));
    changed += generateBarrel(pkgDir, join(pkgDir, folderBarrelFile(directory)), modules, false);
  }
  return changed;
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
      `${pluralize(failures.length, "barrel")} failed: ${names.join(", ")}`,
    );
  }
  return total;
}
