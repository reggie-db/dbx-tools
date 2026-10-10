#!/usr/bin/env -S bun
/**
 * Synchronize pinned Git source subsets into Python generated package trees.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as exec from "@dbx-tools/core/exec";
import { withFileLock } from "@dbx-tools/core/file-lock";
import { parse } from "smol-toml";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import {
  TaskCheckOptionSchema,
  TaskForceOptionSchema,
  TaskProjectOptionSchema,
} from "./options.ts";
import { PYTHON_GENERATED_PACKAGE, PYTHON_SYNC_PACKAGE } from "../src/generated.ts";

/** AST rewriter that points absolute imports of synchronized modules at their generated package. */
const LOCALIZER = join(import.meta.dirname, "python-localize-imports.py");

interface SyncConfig {
  readonly name?: string;
  readonly source: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly replace?: Readonly<Record<string, string>>;
  readonly localize_imports?: boolean | readonly string[];
}

interface SyncManifest {
  readonly optionsHash: string;
  readonly resolvedCommit: string;
  readonly source: string;
}

interface ParsedSource {
  readonly repository: string;
  readonly reference: string;
  readonly subdirectory?: string;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const schema = z.object({
    project: TaskProjectOptionSchema,
    force: TaskForceOptionSchema,
    check: TaskCheckOptionSchema,
  });
  const options = await taskOptions(
    taskCommand(import.meta.url, "Synchronize pinned Git sources into Python packages", schema),
    schema,
    args,
  );
  const project = resolve(options.project);
  const pyproject = parse(readFileSync(join(project, "pyproject.toml"), "utf8")) as {
    tool?: {
      uv?: { "build-backend"?: { "module-name"?: string; "module-root"?: string } };
      dbx_tools?: { sync?: SyncConfig | SyncConfig[] };
    };
  };
  const configured = pyproject.tool?.dbx_tools?.sync;
  const configs = configured ? (Array.isArray(configured) ? configured : [configured]) : [];
  const build = pyproject.tool?.uv?.["build-backend"];
  const moduleName = build?.["module-name"];
  if (!moduleName) throw new Error(`${project}/pyproject.toml has no uv module-name`);
  const moduleRoot = resolve(project, build?.["module-root"] ?? "src");
  // The import package and the output directory derive from the same segments.
  const generatedPackage = [moduleName, PYTHON_GENERATED_PACKAGE, PYTHON_SYNC_PACKAGE].join(".");
  const generatedRoot = join(moduleRoot, ...generatedPackage.split("."));
  for (const config of configs) {
    await synchronize(config, generatedRoot, generatedPackage, options);
  }
}

async function synchronize(
  config: SyncConfig,
  generatedRoot: string,
  generatedPackage: string,
  options: { readonly check: boolean; readonly force: boolean },
): Promise<void> {
  const source = parseSource(config.source);
  const name = config.name ?? defaultName(source);
  const target = join(generatedRoot, name);
  const localize = localizedModules(config, name);
  const importPackage = `${generatedPackage}.${name}`;
  const optionsHash = hash({
    exclude: [...(config.exclude ?? [])].sort(),
    include: [...(config.include ?? ["**/*"])].sort(),
    localize: localize && {
      localizer: hash(readFileSync(LOCALIZER, "utf8")),
      modules: [...localize].sort(),
      package: importPackage,
    },
    name,
    replace: config.replace ?? {},
    source: config.source,
  });
  const initialManifest = readManifest(target);
  if (
    !options.force &&
    initialManifest?.optionsHash === optionsHash &&
    /^[a-f0-9]{40}$/i.test(source.reference) &&
    initialManifest.resolvedCommit === source.reference.toLowerCase()
  ) {
    return;
  }
  const initialCommit = resolveCommit(source);
  if (
    !options.force &&
    initialManifest?.optionsHash === optionsHash &&
    initialManifest.resolvedCommit === initialCommit
  ) {
    return;
  }
  await withFileLock(["python-sync", target], async () => {
    const resolvedCommit = resolveCommit(source);
    const manifest = readManifest(target);
    if (
      !options.force &&
      manifest?.optionsHash === optionsHash &&
      manifest.resolvedCommit === resolvedCommit
    ) {
      return;
    }
    if (options.check) throw new Error(`Generated Python sync is stale: ${target}`);
    replaceTarget(
      config,
      source,
      target,
      localize && { modules: localize, package: importPackage },
      { optionsHash, resolvedCommit },
    );
  });
}

function replaceTarget(
  config: SyncConfig,
  source: ParsedSource,
  target: string,
  localize: { readonly modules: readonly string[]; readonly package: string } | undefined,
  manifest: Omit<SyncManifest, "source">,
): void {
  const temporary = mkdtempSync(join(tmpdir(), "dbx-tools-python-sync-"));
  const checkout = join(temporary, "checkout");
  const staging = join(temporary, "staging");
  try {
    execFileSync("git", ["init", "--quiet", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "fetch",
      "--quiet",
      "--depth=1",
      source.repository,
      source.reference,
    ]);
    execFileSync("git", ["-C", checkout, "checkout", "--quiet", "FETCH_HEAD"]);
    const root = resolve(checkout, source.subdirectory ?? ".");
    mkdirSync(staging, { recursive: true });
    const included = new Set<string>();
    const replacements = new Map(Object.keys(config.replace ?? {}).map((value) => [value, 0]));
    for (const pattern of config.include ?? ["**/*"]) {
      for (const relative of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
        included.add(relative);
      }
    }
    const excluded = (config.exclude ?? []).map((pattern) => new Bun.Glob(pattern));
    for (const relative of [...included].sort()) {
      if (excluded.some((glob) => glob.match(relative))) continue;
      const destination = join(staging, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, relative), destination);
      if (relative.endsWith(".py") && config.replace) {
        let contents = readFileSync(destination, "utf8");
        for (const [from, to] of Object.entries(config.replace)) {
          const matches = contents.split(from).length - 1;
          if (matches > 0) replacements.set(from, (replacements.get(from) ?? 0) + matches);
          contents = contents.replaceAll(from, to);
        }
        writeFileSync(destination, contents);
      }
    }
    const missing = [...replacements]
      .filter(([, matches]) => matches === 0)
      .map(([value]) => value);
    if (missing.length > 0) {
      throw new Error(
        `Python sync replacements did not match ${source.repository}: ${missing.join(", ")}`,
      );
    }
    if (localize) localizeImports(staging, source, localize.package, localize.modules);
    const license = join(checkout, "LICENSE");
    if (existsSync(license)) cpSync(license, join(staging, "LICENSE.upstream"));
    writeFileSync(
      join(staging, ".sync.json"),
      `${JSON.stringify({ ...manifest, source: config.source }, null, 2)}\n`,
    );
    makeWritable(target);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
    makeReadonly(target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Upstream modules whose imports are rewritten: empty to detect every synchronized
 * module, or `undefined` when localization is off. A sync whose name is not a Python
 * identifier is not importable as a package, so it only localizes when asked to.
 */
function localizedModules(config: SyncConfig, name: string): readonly string[] | undefined {
  const option = config.localize_imports;
  if (option === false) return undefined;
  if (Array.isArray(option) && option.length === 0) {
    throw new Error(`Python sync ${name} lists no localize_imports modules; use false instead`);
  }
  if (!PYTHON_IDENTIFIER.test(name)) {
    if (option === undefined) return undefined;
    throw new Error(`Python sync name ${name} must be a Python identifier to localize imports`);
  }
  return Array.isArray(option) ? option : [];
}

const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function localizeImports(
  staging: string,
  source: ParsedSource,
  importPackage: string,
  modules: readonly string[],
): void {
  // Upstream code may import its modules under the subdirectory's dotted path.
  const segments = (source.subdirectory ?? "").split("/").filter(Boolean);
  const sourcePackage = segments.every((segment) => PYTHON_IDENTIFIER.test(segment))
    ? segments.join(".")
    : "";
  // Captured stderr carries the localizer's reason into the thrown error.
  const { stdout } = exec.spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "--quiet",
      "python",
      LOCALIZER,
      staging,
      importPackage,
      sourcePackage,
      ...modules,
    ],
    { cwd: staging, stdout: "capture", stderr: "capture", stdin: "ignore", check: true },
  );
  const counts = JSON.parse(stdout ?? "{}") as Record<string, number>;
  const missing = modules.filter((module) => !counts[module]);
  if (missing.length > 0) {
    throw new Error(
      `Python sync localize_imports did not match ${source.repository}: ${missing.join(", ")}`,
    );
  }
}

function parseSource(value: string): ParsedSource {
  const match = /^(?:(.*?)\s+@\s+)?git\+(.+?)@([^#]+)(?:#subdirectory=(.+))?$/.exec(value);
  if (!match) throw new Error(`Invalid pip Git source: ${value}`);
  return {
    repository: match[2]!,
    reference: match[3]!,
    ...(match[4] ? { subdirectory: match[4] } : {}),
  };
}

function resolveCommit(source: ParsedSource): string {
  if (/^[a-f0-9]{40}$/i.test(source.reference)) return source.reference.toLowerCase();
  const output = execFileSync("git", ["ls-remote", source.repository, source.reference], {
    encoding: "utf8",
  }).trim();
  const commit = output.split(/\s+/, 1)[0];
  if (!commit) throw new Error(`Could not resolve ${source.reference} from ${source.repository}`);
  return commit.toLowerCase();
}

function defaultName(source: ParsedSource): string {
  const repository = basename(source.repository, ".git");
  const owner = basename(dirname(source.repository));
  return `${safeName(owner)}-${safeName(repository)}-${hash(source.repository).slice(0, 8)}`;
}

function safeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readManifest(target: string): SyncManifest | undefined {
  const path = join(target, ".sync.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SyncManifest) : undefined;
}

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } else {
    chmodSync(path, 0o644);
  }
}

function makeReadonly(path: string): void {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) makeReadonly(join(path, entry));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, 0o444);
  }
}

await runTaskMain(import.meta, main);
