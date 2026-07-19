#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const siteRoot = path.join(root, ".docs-build", "site");
const docsRoot = path.join(siteRoot, "src", "content", "docs");
const apiRoot = path.join(docsRoot, "api");
const typedocTsconfig = path.join(siteRoot, "typedoc.tsconfig.json");

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const posix = (p) => p.split(path.sep).join("/");

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

function packageSlug(name) {
  return name
    .replace(/^@dbx-tools\//, "")
    .replace(/^@/, "")
    .replace(/\//g, "-");
}

/** Human label for a package's `workspaces/<group>/…` area (mirrors sync-readmes). */
function groupTitle(group) {
  switch (group) {
    case "node":
      return "Node and AppKit";
    case "shared":
      return "Shared Contracts";
    case "cli":
      return "CLI Tools";
    case "ui":
      return "React UI";
    default:
      return group.charAt(0).toUpperCase() + group.slice(1);
  }
}

/** First real prose paragraph of a README (skips the H1, code fences, tables). */
function firstParagraph(markdown) {
  return markdown
    .replace(/^# .*(\r?\n)+/, "")
    .split(/\r?\n\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("```") && !s.startsWith("|"))
    ?.replace(/\s+/g, " ");
}

function discoverPackages() {
  return walk(path.join(root, "workspaces"))
    .filter((p) => path.basename(p) === "package.json")
    .map((packageJson) => {
      const pkg = JSON.parse(read(packageJson));
      const dir = path.dirname(packageJson);
      const entry = path.join(dir, "index.ts");
      const readme = path.join(dir, "README.md");
      // `workspaces/<group>/<pkg>` -> the `<group>` segment, for the area column.
      const group = posix(path.relative(root, dir)).split("/")[1] ?? "other";
      return {
        name: pkg.name,
        slug: packageSlug(pkg.name),
        dir,
        entry,
        readme,
        group,
      };
    })
    .filter((pkg) => fs.existsSync(pkg.entry))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function titleFromMarkdown(markdown, fallback) {
  return markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || fallback;
}

function stripLeadingH1(markdown) {
  return markdown.replace(/^#\s+.+?(?:\r?\n)+/, "");
}

function yamlString(value) {
  return JSON.stringify(value ?? "");
}

/**
 * Strip the `.md` suffix from relative TypeDoc cross-links so Starlight
 * resolves them (it serves extension-less routes). External links (`http`,
 * `mailto`, anchors, absolute paths) pass through untouched. The remaining
 * case/dot mismatch between the flat filenames and Starlight's slugs is
 * reconciled later by {@link slugifyApiFiles}.
 */
function normalizeTypedocLinks(markdown) {
  return markdown.replace(
    /(\]\()([^)]+?)(\.md)(#[^)]+)?(\))/g,
    (match, open, target, _md, hash = "", close) => {
      if (/^(https?:|mailto:|#|\/)/.test(target)) return match;
      return `${open}${target}${hash}${close}`;
    },
  );
}

/**
 * The route slug Starlight derives from a content filename: lowercase and dots
 * removed. `--flattenOutputFiles` emits dotted, mixed-case names like
 * `Namespace.databricks.md` and `databricks.TypeAlias.ContextLike.md`, so their
 * served routes collapse to `namespacedatabricks` / `databrickstypealiascontextlike`.
 * We rename each page to a hyphenated form of that slug (readable, collision-free,
 * and unchanged by the slugifier) so the on-disk filename equals the served route.
 */
function apiSlug(basenameNoExt) {
  return basenameNoExt.toLowerCase().replace(/\./g, "-");
}

/**
 * Reconcile flat TypeDoc filenames with the routes Starlight actually serves.
 * TypeDoc's mixed-case, dotted filenames slugify to lowercase, dot-free routes,
 * but the generated cross-links keep the original name - so every API link
 * resolves to a nonexistent route (a sitewide 404). Rename each page (except
 * `index.md`, which is the directory root) to `apiSlug(name)`, then rewrite
 * every intra-package link target to match. Runs last, after empty pages are
 * pruned, so no link points at a removed file.
 */
function slugifyApiFiles(outDir) {
  const files = walk(outDir).filter((p) => p.endsWith(".md"));
  const rename = new Map();
  for (const file of files) {
    const base = path.basename(file, ".md");
    if (base === "index") continue;
    const slug = apiSlug(base);
    if (slug !== base) rename.set(base, slug);
  }
  if (rename.size === 0) return;
  // Rewrite links first (targets are extension-less basenames after
  // `normalizeTypedocLinks`), then move the files.
  for (const file of files) {
    const text = read(file);
    const next = text.replace(
      /(\]\()(\.\/)?([^)#]+)(#[^)]+)?(\))/g,
      (match, open, dot = "", target, hash = "", close) => {
        const slug = rename.get(target);
        return slug ? `${open}${dot}${slug}${hash}${close}` : match;
      },
    );
    if (next !== text) write(file, next);
  }
  for (const [base, slug] of rename) {
    const from = path.join(outDir, `${base}.md`);
    const to = path.join(outDir, `${slug}.md`);
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
}

/**
 * Drop TypeDoc's `## References` section from a package `index.md`. It lists
 * the barrel's `export { … } from` re-exports as `Re-exports [X]` entries, each
 * just re-linking a symbol already documented under its namespace - noise that
 * adds nothing. Removes the heading through the next H2 (or end of file).
 */
function stripReExports(indexPath) {
  if (!fs.existsSync(indexPath)) return;
  const lines = read(indexPath).split("\n");
  const start = lines.findIndex((l) => l.trim() === "## References");
  if (start === -1) return;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  lines.splice(start, end - start);
  write(indexPath, `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);
}

function addFrontmatter(file, fallbackTitle, sourcePath) {
  const markdown = normalizeTypedocLinks(read(file));
  if (markdown.startsWith("---\n")) return;
  const title = titleFromMarkdown(markdown, fallbackTitle);
  const body = stripLeadingH1(markdown);
  write(
    file,
    [
      "---",
      `title: ${yamlString(title)}`,
      `description: ${yamlString(`Generated TypeScript API reference for ${fallbackTitle}.`)}`,
      `source: ${yamlString(posix(path.relative(root, sourcePath)))}`,
      "---",
      "",
      "<!--",
      "  Generated by docs/scripts/generate-api-docs.mjs.",
      "  Do not edit generated files under .docs-build/.",
      "-->",
      "",
      body,
    ].join("\n"),
  );
}

function relativeLink(fromFile, toFile) {
  let rel = posix(path.relative(path.dirname(fromFile), toFile));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.md$/, "");
}

function buildApiIndex(packages) {
  const indexPath = path.join(apiRoot, "index.md");
  const rows = packages
    .map((pkg) => {
      const link = relativeLink(indexPath, path.join(apiRoot, pkg.slug, "index.md"));
      const summary = (
        (fs.existsSync(pkg.readme) ? firstParagraph(read(pkg.readme)) : "") ?? ""
      ).replace(/\|/g, "\\|");
      return `| [${pkg.name}](${link}) | ${groupTitle(pkg.group)} | ${summary} |`;
    })
    .join("\n");
  return [
    "---",
    'title: "API Reference"',
    'description: "Generated TypeScript API reference for dbx-tools packages."',
    'source: "workspaces"',
    "---",
    "",
    "<!--",
    "  Generated by docs/scripts/generate-api-docs.mjs.",
    "  Do not edit generated files under .docs-build/.",
    "-->",
    "",
    "Generated from each package's TypeScript exports and JSDoc. For usage guides and rationale, start with the package's README under Package Reference; edit the source types / JSDoc and rerun the docs generator to update these pages.",
    "",
    "| Package | Area | Summary |",
    "| --- | --- | --- |",
    rows,
    "",
  ].join("\n");
}

/**
 * The prose body of a generated page, with frontmatter, the generated-file
 * HTML comment, headings, list items, and horizontal rules stripped. Empty
 * when the page carries no actual documentation - just navigation.
 */
function pageProse(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "") // frontmatter
    .replace(/<!--[\s\S]*?-->/g, "") // generated-file comment
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (t === "" || t === "***") return false; // blank / rule
      if (t.startsWith("#")) return false; // heading
      if (/^[-*] /.test(t)) return false; // list item (link list)
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Drop `Namespace.*.md` pages that carry no prose - a bare list of the symbols
 * they re-export adds nothing the symbol pages and the package index don't
 * already give (per the "useful or omitted" rule). A namespace page gets real
 * content by adding a `@module` doc comment to its source file; until then it
 * is omitted. Links to the removed pages are stripped from the package
 * `index.md` so no dead nav entry is left behind.
 */
function pruneEmptyNamespacePages(outDir) {
  const removedSlugs = [];
  for (const file of walk(outDir).filter((p) => /\/Namespace\.[^/]+\.md$/.test(posix(p)))) {
    if (pageProse(read(file)) === "") {
      removedSlugs.push(path.basename(file, ".md"));
      fs.rmSync(file);
    }
  }
  if (removedSlugs.length === 0) return;
  const indexPath = path.join(outDir, "index.md");
  if (!fs.existsSync(indexPath)) return;
  const removed = new Set(removedSlugs);
  const index = read(indexPath)
    .split("\n")
    // Drop `- [name](Namespace.x)` links that point at a removed page.
    .filter((line) => {
      const m = line.match(/^[-*] \[[^\]]+\]\((Namespace\.[^)#]+)/);
      return !(m && removed.has(m[1]));
    })
    .join("\n")
    // Collapse a now-empty `## Namespaces` heading (no links under it).
    .replace(/^## Namespaces\n(?=\n*(##|$))/m, "");
  write(indexPath, index);
}

function generatePackageApi(pkg) {
  const outDir = path.join(apiRoot, pkg.slug);
  fs.rmSync(outDir, { recursive: true, force: true });

  const result = spawnSync(
    "pnpm",
    [
      "--dir",
      siteRoot,
      "exec",
      "typedoc",
      posix(path.relative(siteRoot, pkg.entry)),
      "--plugin",
      "typedoc-plugin-markdown",
      "--tsconfig",
      posix(path.relative(siteRoot, typedocTsconfig)),
      "--out",
      posix(path.relative(siteRoot, outDir)),
      "--entryFileName",
      "index.md",
      // Flat, same-directory filenames. Without this TypeDoc nests output
      // under a literal `@dbx-tools/` folder, which corrupts every cross-link
      // and breaks case-sensitive filenames on the Linux CI runner.
      "--flattenOutputFiles",
      "true",
      "--readme",
      "none",
      "--hidePageHeader",
      "--hideBreadcrumbs",
      "--skipErrorChecking",
      "--disableSources",
      "--cleanOutputDir",
      "true",
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    throw new Error(`TypeDoc failed for ${pkg.name}\n${output}`);
  }

  const mdFiles = walk(outDir).filter((p) => p.endsWith(".md"));
  for (const file of mdFiles) {
    addFrontmatter(file, pkg.name, pkg.entry);
  }

  pruneEmptyNamespacePages(outDir);

  // A package with real API surface emits per-symbol pages. With flat output
  // TypeDoc names them `<scope>.<Kind>.<Symbol>.md` (e.g.
  // `resolve.Function.rankModels.md`, `model.Enumeration.ModelClass.md`); the
  // singular capitalized `<Kind>` marks a documented symbol. `index.md` and
  // `Namespace.<x>.md` stubs carry no symbol of their own. If nothing but
  // stubs was produced there's nothing worth publishing, so drop the dir.
  // Test against the flat TypeDoc names, before slugification rewrites them.
  const hasSymbols = mdFiles.some((p) =>
    /\.(Function|Interface|TypeAlias|Enumeration|Variable|Class)\./.test(
      path.basename(p),
    ),
  );
  if (!hasSymbols) {
    fs.rmSync(outDir, { recursive: true, force: true });
    return false;
  }

  // Drop the re-export noise, then rename files + rewrite links so the on-disk
  // names match the routes Starlight serves (must be last - it moves files).
  stripReExports(path.join(outDir, "index.md"));
  slugifyApiFiles(outDir);
  return true;
}

function main() {
  if (!fs.existsSync(siteRoot)) {
    throw new Error("Missing .docs-build/site. Run docs/scripts/sync-readmes.mjs first.");
  }

  write(
    typedocTsconfig,
    `${JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["../../workspaces/**/*.ts", "../../workspaces/**/*.tsx"],
        exclude: ["../../**/dist", "../../**/node_modules"],
      },
      null,
      2,
    )}\n`,
  );

  const packages = discoverPackages();
  fs.rmSync(apiRoot, { recursive: true, force: true });
  fs.mkdirSync(apiRoot, { recursive: true });

  const generated = [];
  for (const pkg of packages) {
    if (generatePackageApi(pkg)) generated.push(pkg);
  }

  write(path.join(apiRoot, "index.md"), buildApiIndex(generated));
  console.log(
    `Generated TypeScript API docs for ${generated.length} packages into ${posix(path.relative(root, apiRoot))}`,
  );
}

main();
