#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { resolvePackageTypeScriptExports } from "./package-exports.mjs";

const DEFAULT_BASELINE = "docs/source-doc-baseline.json";
const GENERATED_PATHS = [
  /\/src\/generated\//,
  /\/src\/_bindings(?:-ffi)?\.ts$/,
  /\/src\/bindings\.ts$/,
  /\/src\/dashboards\.ts$/,
  /\/src\/_rust-release-binaries\.ts$/,
];

const posix = (value) => value.split(path.sep).join("/");

function walk(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "dist", "lib", "node_modules"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else files.push(file);
  }
  return files;
}

function discoverPackages(root) {
  return walk(path.join(root, "packages", "js"))
    .filter((file) => path.basename(file) === "package.json")
    .map((manifest) => ({ manifest, value: JSON.parse(fs.readFileSync(manifest, "utf8")) }))
    .filter(({ value }) => value.private !== true)
    .map(({ manifest, value }) => ({
      name: value.name,
      dir: path.dirname(manifest),
      entries: resolvePackageTypeScriptExports(manifest),
    }))
    .filter((pkg) => pkg.entries.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function generatedSource(root, source) {
  const relative = `/${posix(path.relative(root, source))}`;
  if (GENERATED_PATHS.some((pattern) => pattern.test(relative))) return true;
  const header = fs.readFileSync(source, "utf8").slice(0, 500);
  return /(?:GENERATED|Generated).*(?:DO NOT EDIT|Do not edit)/s.test(header);
}

function compilerOptions() {
  return {
    allowImportingTsExtensions: true,
    allowJs: false,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
}

function resolvedSymbol(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolDocumentation(checker, symbol) {
  const prose = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (prose) return prose;
  return symbol.getJsDocTags(checker).length > 0 ? "tagged" : "";
}

function sourceLocation(source, declaration) {
  const position = source.getLineAndCharacterOfPosition(declaration.getStart(source));
  return position.line + 1;
}

function targetKey(symbol, declaration) {
  return `${declaration.getSourceFile().fileName}\0${declaration.pos}\0${symbol.name}`;
}

/**
 * Return undocumented declarations reachable from public TypeScript export
 * maps. Re-exports owned by another package are checked in their owning package,
 * generated declarations are excluded, and aliases resolving to the same target
 * are collapsed to one documentation requirement.
 */
export function collectUndocumentedPublicSymbols(rootDirectory = process.cwd()) {
  const root = path.resolve(rootDirectory);
  const packages = discoverPackages(root);
  const entryFiles = [
    ...new Set(packages.flatMap((pkg) => pkg.entries.map((entry) => entry.file))),
  ];
  const program = ts.createProgram({ rootNames: entryFiles, options: compilerOptions() });
  const checker = program.getTypeChecker();
  const findings = [];

  for (const pkg of packages) {
    const publicTargets = new Map();
    for (const entry of pkg.entries) {
      const source = program.getSourceFile(entry.file);
      if (!source?.symbol) {
        throw new Error(`Could not load public entry ${entry.file} for ${pkg.name}`);
      }
      for (const exported of checker.getExportsOfModule(source.symbol)) {
        const target = resolvedSymbol(checker, exported);
        const declarations = (target.declarations ?? []).filter((declaration) => {
          if (ts.isSourceFile(declaration)) return false;
          const owner = path.relative(pkg.dir, declaration.getSourceFile().fileName);
          return !owner.startsWith("..") && !path.isAbsolute(owner);
        });
        if (declarations.length === 0) continue;
        const declaration = declarations[0];
        const key = targetKey(target, declaration);
        const record = publicTargets.get(key) ?? {
          symbol: target,
          declaration,
          exports: new Set(),
        };
        record.exports.add(`${entry.importPath}#${exported.name}`);
        publicTargets.set(key, record);
      }
    }

    for (const record of publicTargets.values()) {
      const source = record.declaration.getSourceFile();
      if (generatedSource(root, source.fileName)) continue;
      if (symbolDocumentation(checker, record.symbol)) continue;
      findings.push({
        package: pkg.name,
        name: record.symbol.name.replace(/^"|"$/g, ""),
        source: posix(path.relative(root, source.fileName)),
        line: sourceLocation(source, record.declaration),
        exports: [...record.exports].sort(),
      });
    }
  }

  return findings.sort(
    (left, right) =>
      left.package.localeCompare(right.package) ||
      left.source.localeCompare(right.source) ||
      left.name.localeCompare(right.name),
  );
}

function baselineRecord(finding) {
  return {
    package: finding.package,
    name: finding.name,
    source: finding.source,
  };
}

function baselineKey(record) {
  return `${record.package}\0${record.source}\0${record.name}`;
}

function writeBaseline(file, findings) {
  const value = {
    version: 1,
    policy:
      "Manifest-exported handwritten TypeScript declarations may not add undocumented symbols. Remove entries as source documentation is added.",
    undocumented: findings.map(baselineRecord),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function printRecords(label, records) {
  if (records.length === 0) return;
  process.stderr.write(`${label}:\n`);
  for (const record of records) {
    const line = record.line ? `:${record.line}` : "";
    process.stderr.write(`  ${record.package} ${record.name} (${record.source}${line})\n`);
  }
}

function main() {
  const root = process.cwd();
  const baselineArgument = process.argv.find((argument) => argument.startsWith("--baseline="));
  const baseline = path.resolve(
    root,
    baselineArgument?.slice("--baseline=".length) ?? DEFAULT_BASELINE,
  );
  const findings = collectUndocumentedPublicSymbols(root);
  if (process.argv.includes("--write-baseline")) {
    writeBaseline(baseline, findings);
    console.log(
      `Wrote ${findings.length} undocumented public symbols to ${posix(path.relative(root, baseline))}`,
    );
    return;
  }
  if (!fs.existsSync(baseline)) {
    throw new Error(
      `Missing source documentation baseline: ${posix(path.relative(root, baseline))}`,
    );
  }

  const expected = JSON.parse(fs.readFileSync(baseline, "utf8")).undocumented ?? [];
  const expectedByKey = new Map(expected.map((record) => [baselineKey(record), record]));
  const actualByKey = new Map(findings.map((record) => [baselineKey(record), record]));
  const added = findings.filter((record) => !expectedByKey.has(baselineKey(record)));
  const resolved = expected.filter((record) => !actualByKey.has(baselineKey(record)));
  if (added.length > 0 || resolved.length > 0) {
    printRecords("New undocumented public symbols", added);
    printRecords("Documented or removed baseline symbols", resolved);
    throw new Error(
      "Public source documentation changed. Add missing JSDoc, then run " +
        "`bun docs/scripts/check-source-docs.mjs --write-baseline` to ratchet the baseline.",
    );
  }
  console.log(
    `Validated ${findings.length} existing undocumented public TypeScript symbols; no new debt was added.`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) main();
