import fs from "node:fs";
import path from "node:path";

const TYPESCRIPT_EXPORT = /\.(?:[cm]?ts|tsx)$/i;
const CONDITION_PRIORITY = ["types", "bun", "browser", "node", "import", "default", "require"];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const posix = (value) => value.split(path.sep).join("/");

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
  if (isRecord(value)) {
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
  if (isRecord(exportsValue)) {
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
  for (const [subpath, value] of exportMapEntries(manifest.exports)) {
    if (subpath !== "." && !subpath.startsWith("./")) {
      throw new Error(`Invalid export subpath ${subpath} in ${manifest.name}`);
    }
    const context = `${manifest.name} export ${subpath}`;
    const candidates = targetCandidates(value, context).map((target) => ({
      target,
      file: insidePackage(packageDir, target, context),
    }));
    const codeCandidates = candidates.filter(({ target }) => TYPESCRIPT_EXPORT.test(target));
    if (codeCandidates.length === 0) continue;
    if (codeCandidates.some(({ target }) => target.includes("*"))) {
      throw new Error(`Wildcard TypeScript export is not supported for ${context}`);
    }
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
