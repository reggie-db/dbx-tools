import fs from "node:fs";
import path from "node:path";
import { pattern } from "@dbx-tools/shared-core";

/** Convert a filesystem path to repository-style POSIX separators. */
export const posix = (value) => value.split(path.sep).join("/");

/** Prefix a site-absolute path with the configured deployment base. */
export function withBasePath(base, sitePath) {
  if (!sitePath.startsWith("/")) return sitePath;
  if (base && (sitePath === base || sitePath.startsWith(`${base}/`))) return sitePath;
  return `${base}${sitePath}`;
}

/** Recursively collect files while skipping dependency, Git, and caller-named trees. */
export function walk(dir, files = [], skip = []) {
  if (!fs.existsSync(dir)) return files;
  const skipped = new Set(["node_modules", ".git", ...skip]);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target, files, skip);
    else files.push(target);
  }
  return files;
}

/** Escape a literal string for interpolation into a regular expression. */
export const escapeRegExp = pattern.escapeRegExp;

/** Remove one leading Markdown H1 and its following blank space. */
export function stripLeadingH1(markdown) {
  return markdown.replace(/^#\s+.+?(?:\r?\n)+/, "");
}

/** Quote a scalar safely for the generated YAML frontmatter subset. */
export function yamlString(value) {
  return JSON.stringify(value ?? "");
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
      return "Shared contracts";
    case "cli":
      return "CLI tools";
    case "ui":
      return "React UI";
    case "python":
      return "Python";
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

/** Prose paragraphs, excluding fenced code, headings, lists, tables, quotes, and HTML blocks. */
export function proseParagraphs(markdown) {
  const paragraphs = [];
  let current = [];
  let fenced = false;
  let skipIndentedContinuation = false;
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(" ").replace(/\s+/g, " ").trim());
    current = [];
  };

  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      skipIndentedContinuation = false;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === "") {
      flush();
      skipIndentedContinuation = false;
      continue;
    }
    if (/^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||<)/.test(line)) {
      flush();
      skipIndentedContinuation = /^\s*(?:[-*+]\s|\d+[.)]\s|\|)/.test(line);
      continue;
    }
    if (skipIndentedContinuation && /^\s{2,}/.test(line)) continue;
    skipIndentedContinuation = false;
    current.push(line.trim());
  }
  flush();
  return paragraphs.filter(Boolean);
}

/** Structural quality issues that make a package README unsuitable as a docs page. */
export function packageReadmeIssues(markdown) {
  const issues = [];
  const firstCodeLine = markdown
    .split(/\r?\n/)
    .findIndex((line) => /^```[a-z0-9-]*$/i.test(line));
  if (!markdown.startsWith("# ")) issues.push("start with one H1 title");
  if (summaryText(markdown).length < 40) {
    issues.push("open with a useful summary of at least 40 characters");
  }
  if ([...markdown.matchAll(/^##\s+\S/gm)].length < 2) {
    issues.push("include at least two task-oriented H2 sections");
  }
  if (!/^```[a-z0-9-]*$/im.test(markdown)) {
    issues.push("include at least one runnable usage example");
  } else if (firstCodeLine >= 20) {
    issues.push("show the first runnable usage example within the first 20 lines");
  }
  if (/\bImport this package when\b/i.test(markdown)) {
    issues.push("describe the user task directly instead of saying 'Import this package when'");
  }
  if (/\b(?:canonical owner|this package owns|does not own)\b/i.test(markdown)) {
    issues.push("move repository ownership policy out of the user guide");
  }
  if (/^## Why (?:Not Just|Use This|This Over)/im.test(markdown)) {
    issues.push("use a task or decision heading instead of a defensive 'Why' heading");
  }
  if (/^## API map\s*$/im.test(markdown) || /^\|\s*Use case\s*\|\s*API\s*\|/im.test(markdown)) {
    issues.push("link APIs where they are discussed instead of adding an API-map table");
  }
  const longestParagraph = Math.max(
    0,
    ...proseParagraphs(markdown).map((paragraph) => paragraph.split(/\s+/).length),
  );
  if (longestParagraph > 120) {
    issues.push(`split prose paragraphs longer than 120 words (found ${longestParagraph})`);
  }
  return issues;
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function tomlSection(manifest, name, array = false) {
  const escaped = escapeRegExp(name);
  const header = array ? `\\[\\[${escaped}\\]\\]` : `\\[${escaped}\\]`;
  return (
    read(manifest).match(
      new RegExp(`^${header}\\s*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"),
    )?.[1] ?? ""
  );
}

function tomlString(section, key) {
  const escaped = escapeRegExp(key);
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
  return walk(path.join(root, "packages", "js"), [], ["build", "coverage", "dist", "lib", "out"])
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

/** Complete published package catalogue used by README-based documentation. */
export function discoverRepositoryPackages(root) {
  return [...discoverJavaScriptPackages(root), ...discoverPythonPackages(root)].sort(
    (left, right) => left.group.localeCompare(right.group) || left.name.localeCompare(right.name),
  );
}
