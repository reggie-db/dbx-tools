import fs from "node:fs";
import path from "node:path";
import { object } from "@dbx-tools/shared-core";
import { escapeRegExp, posix } from "./repository-docs.mjs";

const TYPESCRIPT_EXPORT = /\.(?:[cm]?ts|tsx)$/i;
const CONDITION_PRIORITY = ["types", "bun", "browser", "node", "import", "default", "require"];

function orderedConditions(value) {
  const priority = new Map(CONDITION_PRIORITY.map((condition, index) => [condition, index]));
  return Object.entries(value).sort(([left], [right]) => {
    const leftPriority = priority.get(left) ?? CONDITION_PRIORITY.length;
    const rightPriority = priority.get(right) ?? CONDITION_PRIORITY.length;
    return leftPriority - rightPriority || left.localeCompare(right);
  });
}

function targetCandidates(value, context) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => targetCandidates(candidate, context));
  }
  if (object.isRecord(value)) {
    return orderedConditions(value).flatMap(([condition, candidate]) =>
      targetCandidates(candidate, `${context} condition ${condition}`),
    );
  }
  if (value === null) return [];
  throw new Error(`Unsupported export target for ${context}`);
}

function insidePackage(packageDir, target, context) {
  if (!target.startsWith("./")) {
    throw new Error(`Export target for ${context} must start with ./, received ${target}`);
  }
  const absolute = path.resolve(packageDir, target);
  const relative = path.relative(packageDir, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Export target for ${context} escapes its package: ${target}`);
  }
  return absolute;
}

function exportMapEntries(exportsValue) {
  if (object.isRecord(exportsValue)) {
    const keys = Object.keys(exportsValue);
    const subpathKeys = keys.filter((key) => key.startsWith("."));
    if (subpathKeys.length > 0) {
      if (subpathKeys.length !== keys.length) {
        throw new Error("Package exports cannot mix subpaths and root conditions");
      }
      return Object.entries(exportsValue);
    }
  }
  return [[".", exportsValue]];
}

function importPath(packageName, subpath) {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
}

function packageFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? packageFiles(file) : [file];
  });
}

function expandWildcardTarget(packageDir, subpath, target, context) {
  if ((subpath.match(/\*/g) ?? []).length !== 1 || (target.match(/\*/g) ?? []).length !== 1) {
    throw new Error(`Wildcard export must contain one * in subpath and target for ${context}`);
  }
  insidePackage(packageDir, target, context);
  const [prefix, suffix] = target.split("*");
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`);
  return packageFiles(packageDir).flatMap((file) => {
    const relativeFile = `./${posix(path.relative(packageDir, file))}`;
    const match = pattern.exec(relativeFile);
    if (!match) return [];
    const replacement = match[1];
    return [{
      subpath: subpath.replace("*", replacement),
      target: relativeFile,
      file,
    }];
  });
}

/**
 * Resolve the TypeScript entry file for every public code subpath in a package
 * export map. Asset, stylesheet, and package-metadata exports are ignored.
 * Conditional exports prefer their type target, then runtime conditions, and
 * select the first code target that exists in the source package.
 */
export function resolvePackageTypeScriptExports(packageJson) {
  const manifestPath = path.resolve(packageJson);
  const packageDir = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error(`Package manifest has no name: ${manifestPath}`);
  }
  if (manifest.exports === undefined) {
    throw new Error(`Published package has no exports map: ${manifest.name}`);
  }

  const entries = [];
  const exportEntries = exportMapEntries(manifest.exports);
  const explicitSubpaths = new Set(
    exportEntries.map(([subpath]) => subpath).filter((subpath) => !subpath.includes("*")),
  );
  for (const [subpath, value] of exportEntries) {
    if (subpath !== "." && !subpath.startsWith("./")) {
      throw new Error(`Invalid export subpath ${subpath} in ${manifest.name}`);
    }
    const context = `${manifest.name} export ${subpath}`;
    const codeTargets = targetCandidates(value, context).filter((target) =>
      TYPESCRIPT_EXPORT.test(target),
    );
    if (subpath.includes("*")) {
      const expanded = codeTargets
        .map((target) => expandWildcardTarget(packageDir, subpath, target, context))
        .find((matches) => matches.length > 0) ?? [];
      for (const selected of expanded) {
        if (explicitSubpaths.has(selected.subpath)) continue;
        entries.push({
          subpath: selected.subpath,
          importPath: importPath(manifest.name, selected.subpath),
          target: selected.target,
          file: selected.file,
          relativeFile: posix(path.relative(packageDir, selected.file)),
        });
      }
      continue;
    }
    const codeCandidates = codeTargets.map((target) => ({
      target,
      file: insidePackage(packageDir, target, context),
    }));
    if (codeCandidates.length === 0) continue;
    const selected = codeCandidates.find(
      ({ file }) => fs.existsSync(file) && fs.statSync(file).isFile(),
    );
    if (!selected) {
      throw new Error(
        `No TypeScript target exists for ${context}: ${codeCandidates.map(({ target }) => target).join(", ")}`,
      );
    }
    entries.push({
      subpath,
      importPath: importPath(manifest.name, subpath),
      target: selected.target,
      file: selected.file,
      relativeFile: posix(path.relative(packageDir, selected.file)),
    });
  }

  return entries.sort(
    (left, right) =>
      Number(right.subpath === ".") - Number(left.subpath === ".") ||
      left.subpath.localeCompare(right.subpath),
  );
}
