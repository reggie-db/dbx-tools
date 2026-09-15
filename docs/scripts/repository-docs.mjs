import fs from "node:fs";
import path from "node:path";

/** Convert a filesystem path to repository-style POSIX separators. */
export const posix = (value) => value.split(path.sep).join("/");

/** Prefix a site-absolute path with the configured deployment base. */
export function withBasePath(base, sitePath) {
  if (!sitePath.startsWith("/")) return sitePath;
  if (base && (sitePath === base || sitePath.startsWith(`${base}/`))) return sitePath;
  return `${base}${sitePath}`;
}

/** Recursively collect files while skipping dependency and Git metadata trees. */
export function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else files.push(target);
  }
  return files;
}

/** Stable docs route slug for an npm-style package name. */
export function packageSlug(name) {
  return name
    .replace(/^@dbx-tools\//, "")
    .replace(/^@/, "")
    .replace(/\//g, "-");
}

/** JavaScript package tier from a repository-relative package path. */
export function packageGroup(packagePath) {
  const [, , group] = posix(packagePath).split("/");
  return group ?? "other";
}

/** Human-readable docs label for a package group. */
export function groupTitle(group) {
  switch (group) {
    case "node":
      return "Node and AppKit";
    case "shared":
      return "Shared Contracts";
    case "cli":
      return "CLI Tools";
    case "ui":
      return "React UI";
    case "python":
      return "Python";
    case "rust":
      return "Rust";
    default:
      return group.charAt(0).toUpperCase() + group.slice(1);
  }
}

/** First prose paragraph after a README title, excluding code and tables. */
export function firstParagraph(markdown) {
  return markdown
    .replace(/^# .*(\r?\n)+/, "")
    .split(/\r?\n\r?\n/)
    .map((section) => section.trim())
    .find((section) => section && !section.startsWith("```") && !section.startsWith("|"))
    ?.replace(/\s+/g, " ");
}

/** Plain prose summary suitable for generated package indexes. */
export function summaryText(markdown) {
  return (firstParagraph(markdown) ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function tomlSection(manifest, name, array = false) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = array ? `\\[\\[${escaped}\\]\\]` : `\\[${escaped}\\]`;
  return (
    read(manifest).match(
      new RegExp(`^${header}\\s*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"),
    )?.[1] ?? ""
  );
}

function tomlString(section, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return section.match(new RegExp(`^\\s*${escaped}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

function requireReadme(root, dir) {
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    throw new Error(`Missing README for ${posix(path.relative(root, dir))}`);
  }
  return readme;
}

/** Published JavaScript package catalogue derived from package manifests. */
export function discoverJavaScriptPackages(root) {
  return walk(path.join(root, "packages", "js"))
    .filter((file) => path.basename(file) === "package.json")
    .map((manifest) => ({ manifest, packageJson: JSON.parse(read(manifest)) }))
    .filter(({ packageJson }) => packageJson.private !== true)
    .map(({ manifest, packageJson }) => {
      const dir = path.dirname(manifest);
      const relDir = posix(path.relative(root, dir));
      return {
        name: packageJson.name,
        dir,
        manifest,
        readme: requireReadme(root, dir),
        relDir,
        group: packageGroup(relDir),
        slug: packageSlug(packageJson.name),
        tsconfig: path.join(dir, "tsconfig.json"),
      };
    })
    .sort(
      (left, right) => left.group.localeCompare(right.group) || left.name.localeCompare(right.name),
    );
}

/** Published Python package catalogue derived from `pyproject.toml`. */
export function discoverPythonPackages(root) {
  const directory = path.join(root, "packages", "py");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "pyproject.toml")))
    .map((dir) => {
      const manifest = path.join(dir, "pyproject.toml");
      const project = tomlSection(manifest, "project");
      return {
        name: tomlString(project, "name") ?? path.basename(dir),
        slug: `py-${path.basename(dir)}`,
        dir,
        manifest,
        readme: requireReadme(root, dir),
        relDir: posix(path.relative(root, dir)),
        group: "python",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Published Rust package catalogue derived from Cargo manifests. */
export function discoverRustPackages(root) {
  const directory = path.join(root, "packages", "rs");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "Cargo.toml")))
    .map((dir) => {
      const manifest = path.join(dir, "Cargo.toml");
      const packageSection = tomlSection(manifest, "package");
      if (/^\s*publish\s*=\s*false\s*$/m.test(packageSection)) return undefined;
      const name = tomlString(packageSection, "name") ?? path.basename(dir);
      const libName = tomlString(tomlSection(manifest, "lib"), "name");
      const binaryName = tomlString(tomlSection(manifest, "bin", true), "name");
      const hasLibrary = fs.existsSync(path.join(dir, "src", "lib.rs"));
      return {
        name,
        slug: `rs-${path.basename(dir)}`,
        dir,
        manifest,
        readme: requireReadme(root, dir),
        relDir: posix(path.relative(root, dir)),
        group: "rust",
        binaryName,
        hasLibrary,
        rustdocTarget: (libName ?? name).replaceAll("-", "_"),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Complete published package catalogue used by README-based documentation. */
export function discoverRepositoryPackages(root) {
  return [
    ...discoverJavaScriptPackages(root),
    ...discoverPythonPackages(root),
    ...discoverRustPackages(root),
  ].sort(
    (left, right) => left.group.localeCompare(right.group) || left.name.localeCompare(right.name),
  );
}
