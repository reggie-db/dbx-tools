/**
 * Runtime-export usage for `@dbx-tools/shared-core`.
 *
 * Classifies each live export as production, test, package-internal, generated
 * binding, or unused. The report is informational; architecture tests fail only
 * unused exports and duplicated owned helpers.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { find } from "@dbx-tools/path";
import * as core from "@dbx-tools/shared-core";
import { PACKAGE_IDENTIFIER, object } from "@dbx-tools/shared-core";
import { PYTHON_GENERATED_PACKAGE } from "./generated.ts";
import { readPackageManifest, recordedPackages, repoRoot } from "./packages.ts";

/** How one runtime export is referenced in this repository. */
export type SharedCoreUsageKind = "production" | "test" | "internal" | "binding" | "unused";

/** One classified shared-core runtime export. */
export interface SharedCoreExportUsage {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly kind: SharedCoreUsageKind;
  readonly files: readonly string[];
}

/** Binding-safe wrappers called from generated Python even without TS imports. */
export const SHARED_CORE_BINDING_EXPORTS = [
  "bindings.logActiveLevel",
  "bindings.logLevelEnabled",
] as const;

const SOURCE_PATTERN = "**/*.{ts,tsx,js,mjs}";
const NAMESPACE_EXPORT = /^export \* as (\w+) from "\.\/src\/([^"]+)\.ts";$/gm;
const LOCAL_OWNED_HELPER =
  /(?:export\s+)?(?:async\s+)?function(?:\s*\*)?\s+(isRecord|sleep|escapeRegExp|trimToNull|trimToUndefined|trimToEmpty)\s*\(|(?:export\s+)?const\s+(isRecord|sleep|escapeRegExp|trimToNull|trimToUndefined|trimToEmpty)\s*=/g;

/** Owners of the shared helpers; other files must import them. */
const OWNED_HELPER_FILES = new Set([
  "packages/js/shared/core/src/object.ts",
  "packages/js/shared/core/src/async-utils.ts",
  "packages/js/shared/core/src/pattern.ts",
  "packages/js/shared/core/src/string-utils.ts",
  "docs/scripts/repository-docs.mjs",
]);

export function sharedCorePackageDir(root: string = repoRoot): string {
  for (const pkg of recordedPackages(root)) {
    if (readPackageManifest(pkg.dir)?.name === PACKAGE_IDENTIFIER) return pkg.dir;
  }
  throw new Error(`workspace package ${PACKAGE_IDENTIFIER} is missing`);
}

function namespaceMap(coreDir: string): Readonly<Record<string, string>> {
  const barrel = readFileSync(join(coreDir, "index.ts"), "utf8");
  return Object.fromEntries(
    [...barrel.matchAll(NAMESPACE_EXPORT)].map((match) => [match[1]!, match[2]!]),
  );
}

function sourceFiles(root: string, includeGenerated: boolean): string[] {
  const ignore = [
    "**/node_modules/**",
    "**/lib/**",
    "**/.docs-build/**",
    // Bundled PythonMonkey runtimes inline shared-core; they are not local copies.
    "**/node_runtime/runtime.js",
    "**/_runtime.js",
  ];
  if (!includeGenerated) ignore.push(`**/${PYTHON_GENERATED_PACKAGE}/**`);
  return [...find.findFiles(SOURCE_PATTERN, { cwd: root, ignore })].sort();
}

function classifyFile(
  relativePath: string,
  coreDirRel: string,
): Exclude<SharedCoreUsageKind, "unused"> {
  if (relativePath.includes(`/${PYTHON_GENERATED_PACKAGE}/`)) return "binding";
  if (relativePath.startsWith(`${coreDirRel}/src/`)) return "internal";
  if (/(?:^|\/)(?:test|tests)\//.test(relativePath) || relativePath.includes(".test.")) {
    return "test";
  }
  return "production";
}

function preferKind(
  current: SharedCoreUsageKind,
  next: Exclude<SharedCoreUsageKind, "unused">,
): SharedCoreUsageKind {
  const rank: Record<SharedCoreUsageKind, number> = {
    production: 0,
    binding: 1,
    internal: 2,
    test: 3,
    unused: 4,
  };
  return rank[next] < rank[current] ? next : current;
}

function mentionsExport(
  source: string,
  namespace: string,
  name: string,
  moduleFile: string,
): boolean {
  if (source.includes(`${namespace}.${name}`)) return true;
  const imported =
    source.includes(`from "@dbx-tools/shared-core/${moduleFile}"`) ||
    source.includes(`from "./${moduleFile}.ts"`) ||
    source.includes(`from "../src/${moduleFile}.ts"`);
  if (!imported) return false;
  return new RegExp(`\\b${name}\\b`).test(source);
}

/** Classify every namespace runtime export against repository callers. */
export function sharedCoreExportUsage(root: string = repoRoot): SharedCoreExportUsage[] {
  const coreDir = sharedCorePackageDir(root);
  const coreDirRel = relative(root, coreDir);
  const namespaces = namespaceMap(coreDir);
  const files = sourceFiles(root, true).map((file) => ({
    path: relative(root, file),
    text: readFileSync(file, "utf8"),
  }));
  const usage: SharedCoreExportUsage[] = [];
  for (const [namespace, moduleFile] of Object.entries(namespaces)) {
    const exported = core[namespace as keyof typeof core];
    if (!exported || typeof exported !== "object") continue;
    for (const name of Object.keys(exported).sort()) {
      if (name === "__esModule" || name === "default") continue;
      const id = `${namespace}.${name}`;
      const defining = `${coreDirRel}/src/${moduleFile}.ts`;
      const matches = files
        .filter(({ path, text }) => {
          if (path === defining) {
            return (text.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0) > 1;
          }
          return mentionsExport(text, namespace, name, moduleFile);
        })
        .map(({ path }) => path);
      let kind: SharedCoreUsageKind = "unused";
      if (
        SHARED_CORE_BINDING_EXPORTS.includes(id as (typeof SHARED_CORE_BINDING_EXPORTS)[number])
      ) {
        kind = "binding";
      }
      for (const file of matches) kind = preferKind(kind, classifyFile(file, coreDirRel));
      usage.push({ id, namespace, name, kind, files: matches });
    }
  }
  return usage.sort((left, right) => left.id.localeCompare(right.id));
}

/** Local copies of helpers owned by shared-core. */
export function duplicatedOwnedHelpers(root: string = repoRoot): string[] {
  const duplicates: string[] = [];
  for (const file of sourceFiles(root, false)) {
    const relativePath = relative(root, file);
    if (OWNED_HELPER_FILES.has(relativePath)) continue;
    if (relativePath.startsWith("packages/js/shared/core/test/")) continue;
    const text = readFileSync(file, "utf8");
    LOCAL_OWNED_HELPER.lastIndex = 0;
    if (LOCAL_OWNED_HELPER.test(text)) duplicates.push(relativePath);
  }
  return duplicates.sort();
}

/** Render a compact usage table for `shared-core:usage`. */
export function formatSharedCoreUsage(usage: readonly SharedCoreExportUsage[]): string {
  const counts = object.sequence(usage).group({
    production: (row) => row.kind === "production",
    binding: (row) => row.kind === "binding",
    internal: (row) => row.kind === "internal",
    test: (row) => row.kind === "test",
    unused: (row) => row.kind === "unused",
  });
  const lines = [
    `shared-core runtime exports: ${usage.length}`,
    `  production ${counts.production.length}`,
    `  binding ${counts.binding.length}`,
    `  internal ${counts.internal.length}`,
    `  test ${counts.test.length}`,
    `  unused ${counts.unused.length}`,
  ];
  if (counts.unused.length > 0) {
    lines.push("unused:");
    for (const row of counts.unused) lines.push(`  ${row.id}`);
  }
  return `${lines.join("\n")}\n`;
}
