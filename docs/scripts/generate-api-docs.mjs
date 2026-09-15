#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePackageTypeScriptExports } from "./package-exports.mjs";
import { docsSiteConfig } from "./site-config.mjs";

const root = process.cwd();
const siteRoot = path.join(root, ".docs-build", "site");
const docsRoot = path.join(siteRoot, "src", "content", "docs");
const apiRoot = path.join(docsRoot, "api");
const publicRoot = path.join(siteRoot, "public");

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const posix = (p) => p.split(path.sep).join("/");

// Use the same route base as the README generator so absolute API links resolve
// under either the custom-domain root or a project-site subpath.
const { base } = docsSiteConfig();

function withBase(sitePath) {
  if (!sitePath.startsWith("/")) return sitePath;
  if (base && (sitePath === base || sitePath.startsWith(`${base}/`))) return sitePath;
  return `${base}${sitePath}`;
}

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

/** Human label for a package's `packages/js/<group>/…` area (mirrors sync-readmes). */
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
    case "python":
      return "Python";
    case "rust":
      return "Rust";
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

/** Plain prose for API package index summaries. */
function summaryText(markdown) {
  return (firstParagraph(markdown) ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

/**
 * Every PUBLISHED package under `packages/js/` that has a TypeScript export.
 *
 * `private: true` manifests are skipped for the same reason the README sync
 * skips them: an unpublished package has no installable API surface, so
 * generating a reference for it only adds pages a reader cannot use.
 */
function discoverPackages() {
  return walk(path.join(root, "packages/js"))
    .filter((p) => path.basename(p) === "package.json")
    .filter((packageJson) => JSON.parse(read(packageJson)).private !== true)
    .map((packageJson) => {
      const pkg = JSON.parse(read(packageJson));
      const dir = path.dirname(packageJson);
      const readme = path.join(dir, "README.md");
      // `packages/js/<group>/<pkg>` -> the `<group>` segment, for the area column.
      const group = posix(path.relative(root, dir)).split("/")[2] ?? "other";
      return {
        name: pkg.name,
        slug: packageSlug(pkg.name),
        dir,
        manifest: packageJson,
        entries: resolvePackageTypeScriptExports(packageJson),
        tsconfig: path.join(dir, "tsconfig.json"),
        readme,
        group,
      };
    })
    .filter((pkg) => pkg.entries.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tomlPackageSection(manifest) {
  return read(manifest).match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
}

function tomlNamedSection(manifest, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    read(manifest).match(
      new RegExp(`^\\[${escaped}\\]\\s*\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"),
    )?.[1] ?? ""
  );
}

function tomlString(section, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return section.match(new RegExp(`^\\s*${escaped}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

function discoverPythonPackages() {
  const directory = path.join(root, "packages", "py");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "pyproject.toml")))
    .map((dir) => {
      const manifest = path.join(dir, "pyproject.toml");
      const project =
        read(manifest).match(/^\[project\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
      return {
        name: tomlString(project, "name") ?? path.basename(dir),
        slug: `py-${path.basename(dir)}`,
        dir,
        manifest,
        readme: path.join(dir, "README.md"),
        group: "python",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function discoverRustPackages() {
  const directory = path.join(root, "packages", "rs");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "Cargo.toml")))
    .map((dir) => {
      const manifest = path.join(dir, "Cargo.toml");
      const packageSection = tomlPackageSection(manifest);
      if (/^\s*publish\s*=\s*false\s*$/m.test(packageSection)) return undefined;
      const name = tomlString(packageSection, "name") ?? path.basename(dir);
      const libName = tomlString(tomlNamedSection(manifest, "lib"), "name");
      const binarySection =
        read(manifest).match(/^\[\[bin\]\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
      const binaryName = tomlString(binarySection, "name");
      const hasLibrary = fs.existsSync(path.join(dir, "src", "lib.rs"));
      const targetName = libName ?? name;
      return {
        name,
        slug: `rs-${path.basename(dir)}`,
        dir,
        manifest,
        readme: path.join(dir, "README.md"),
        group: "rust",
        binaryName,
        hasLibrary,
        rustdocTarget: targetName.replaceAll("-", "_"),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function titleFromMarkdown(markdown, fallback) {
  const heading = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || fallback;
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/~~|[*_`]/g, "")
    .trim();
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

function markdownAnchors(markdown) {
  const anchors = new Set(
    [...markdown.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)].map((match) => match[1]),
  );
  const counts = new Map();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    if (!base) continue;
    const count = counts.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    counts.set(base, count + 1);
  }
  return anchors;
}

/**
 * Reconcile flat TypeDoc filenames with the routes Starlight actually serves,
 * and rewrite intra-package cross-links to absolute, always-resolvable routes.
 *
 * Two problems this fixes:
 *
 *   1. TypeDoc's mixed-case, dotted filenames (`Namespace.mcp.md`,
 *      `mcp.Interface.ResolvedMcp.md`) slugify to lowercase, dot-free routes.
 *      We rename each page (except `index.md`, the directory root) to
 *      `apiSlug(name)` so the on-disk filename equals the served route.
 *   2. Starlight serves EVERY page at a trailing-slash directory route
 *      (`/api/<pkg>/namespace-mcp/`), and raw relative markdown links are
 *      resolved by the browser against that URL. So a bare `mcp-interface-...`
 *      link from a namespace page resolved to a nested child
 *      (`/api/<pkg>/namespace-mcp/mcp-interface-...`) that doesn't exist - a
 *      404. We rewrite every intra-package link to an ABSOLUTE route
 *      (`<base>/api/<pkg>/<slug>`), which resolves identically from the index,
 *      a namespace page, or a symbol page.
 *
 * Verify-and-drop: a link whose target isn't a real page on disk (after
 * rename) is unwrapped to plain text rather than emitted as a 404. Runs last,
 * after empty pages are pruned and re-exports stripped, so the on-disk set is
 * final.
 */
function slugifyApiFiles(outDir) {
  const pkgSlug = path.basename(outDir);
  const files = walk(outDir).filter((p) => p.endsWith(".md"));
  // Map every original basename -> its final slug, and record the set of slugs
  // that actually exist on disk (index included) for the verify-and-drop pass.
  const rename = new Map();
  const slugs = new Set();
  const anchors = new Map();
  for (const file of files) {
    const original = path.basename(file, ".md");
    const slug = original === "index" ? "index" : apiSlug(original);
    slugs.add(slug);
    anchors.set(slug, markdownAnchors(read(file)));
    if (slug !== original) rename.set(original, slug);
  }
  const routeFor = (slug) =>
    slug === "index" ? `${base}/api/${pkgSlug}/` : `${base}/api/${pkgSlug}/${slug}`;
  // A target may arrive as the original dotted name (pre-rename) or already a
  // slug; normalize either to the final slug.
  const targetSlug = (target) =>
    rename.get(target) ?? (slugs.has(target) ? target : apiSlug(target));

  let droppedTotal = 0;
  for (const file of files) {
    const text = read(file);
    const next = text
      .replace(
        /(\[)([^\]]*)(\]\()(\.\/)?([^)#]+)(#[^)]*)?(\))/g,
        (match, lb, label, open, _dot = "", target, hash = "", close) => {
          // Leave external links, anchors, and already-absolute routes alone.
          if (/^(https?:|mailto:|#|\/)/.test(target)) return match;
          const slug = targetSlug(target);
          if (slugs.has(slug) && (!hash || anchors.get(slug)?.has(hash.slice(1)))) {
            return `${lb}${label}${open}${routeFor(slug)}${hash}${close}`;
          }
          // Verify-and-drop: no such page -> unwrap to plain text (keep the hash
          // off; it pointed at a route that doesn't exist).
          droppedTotal += 1;
          return label;
        },
      )
      .replace(/\[([^\]]+)\]\(#([^)]+)\)/g, (match, label, hash) => {
        const slug = path.basename(file, ".md");
        const current = rename.get(slug) ?? (slugs.has(slug) ? slug : apiSlug(slug));
        if (anchors.get(current)?.has(hash)) return match;
        droppedTotal += 1;
        return label;
      });
    if (next !== text) write(file, next);
  }
  if (droppedTotal > 0) {
    console.warn(`  ${pkgSlug}: dropped ${droppedTotal} link(s) with no target page`);
  }
  for (const [original, slug] of rename) {
    const from = path.join(outDir, `${original}.md`);
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
  write(
    indexPath,
    `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`,
  );
}

function addFrontmatter(file, pkg) {
  const markdown = normalizeTypedocLinks(read(file));
  if (markdown.startsWith("---\n")) return;
  const title = titleFromMarkdown(markdown, pkg.name);
  const publishedEntries = pkg.entries.map((entry) => `\`${entry.importPath}\``).join(", ");
  const body = [
    path.basename(file) === "index.md" ? `Published entry points: ${publishedEntries}.` : undefined,
    stripLeadingH1(markdown),
  ]
    .filter(Boolean)
    .join("\n\n");
  write(
    file,
    [
      "---",
      `title: ${yamlString(title)}`,
      `description: ${yamlString(`Generated TypeScript API reference for ${pkg.name}.`)}`,
      `source: ${yamlString(posix(path.relative(root, pkg.manifest)))}`,
      "editUrl: false",
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

function buildApiIndex(packages) {
  const rows = packages
    .map((pkg) => {
      const link = `./${pkg.slug}/`;
      const summary = (fs.existsSync(pkg.readme) ? summaryText(read(pkg.readme)) : "").replace(
        /\|/g,
        "\\|",
      );
      return `| [${pkg.name}](${link}) | ${groupTitle(pkg.group)} | ${summary} |`;
    })
    .join("\n");
  return [
    "---",
    'title: "API Reference"',
    'description: "Generated TypeScript, Python, and Rust API reference for dbx-tools packages."',
    'source: "packages"',
    "editUrl: false",
    "---",
    "",
    "<!--",
    "  Generated by docs/scripts/generate-api-docs.mjs.",
    "  Do not edit generated files under .docs-build/.",
    "-->",
    "",
    "Generated from published TypeScript export maps, Python source ASTs and docstrings, and Cargo rustdoc. For usage guides and rationale, start with the package README under Package Reference; edit the owning source documentation and rerun the docs generator to update these pages.",
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

  // `bun x`, not `pnpm exec`: the repo installs with bun and the docs workflow
  // never puts pnpm on the runner, so spawning it exited with a null status and
  // no output at all (ENOENT), surfacing only as "TypeDoc failed\nnull\nnull".
  // Every path below is already relative to `siteRoot`, so the spawn `cwd` is
  // what points both bun and typedoc at the generated site - `bun x` has no
  // `--cwd` of its own and reads the flag as a dependency spec.
  const result = spawnSync(
    "bun",
    [
      "x",
      "--package",
      "typedoc",
      "--package",
      "typedoc-plugin-markdown",
      "typedoc",
      ...[...new Set(pkg.entries.map((entry) => entry.file))].map((entry) =>
        posix(path.relative(siteRoot, entry)),
      ),
      "--plugin",
      "typedoc-plugin-markdown",
      "--tsconfig",
      posix(path.relative(siteRoot, pkg.tsconfig)),
      "--entryPointStrategy",
      "resolve",
      "--name",
      pkg.name,
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
      "--disableSources",
      "--cleanOutputDir",
      "true",
    ],
    {
      cwd: siteRoot,
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
    addFrontmatter(file, pkg);
  }

  pruneEmptyNamespacePages(outDir);

  // A package with real API surface emits per-symbol pages. Keep the package
  // landing even when it has no declarations so every published package README
  // can link to a stable API route that still records its public import paths.
  const hasSymbols = mdFiles.some((p) =>
    /(?:^|\.)(Function|Interface|TypeAlias|Enumeration|Variable|Class)\./.test(path.basename(p)),
  );
  if (!hasSymbols) {
    console.warn(`  ${pkg.name}: no public TypeScript declarations`);
  }

  // Drop the re-export noise, then rename files + rewrite links so the on-disk
  // names match the routes Starlight serves (must be last - it moves files).
  stripReExports(path.join(outDir, "index.md"));
  slugifyApiFiles(outDir);
  return true;
}

function checkedSpawn(command, args, description, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`${description} failed${output ? `\n${output}` : ""}`);
  }
  if (result.stdout?.trim()) process.stdout.write(`${result.stdout.trim()}\n`);
}

function generatePythonPackageApi(pkg) {
  const output = path.join(apiRoot, pkg.slug, "index.md");
  checkedSpawn(
    "python3",
    [
      path.join(root, "docs", "scripts", "generate_python_api.py"),
      "--package",
      pkg.dir,
      "--output",
      output,
      "--repo-root",
      root,
    ],
    `Python API generation for ${pkg.name}`,
  );
  return fs.existsSync(output);
}

function rustLandingPage(pkg) {
  if (!pkg.hasLibrary) {
    return [
      "---",
      `title: ${yamlString(`${pkg.name} Rust API`)}`,
      `description: ${yamlString(`${pkg.name} publishes an executable and has no Rust library API.`)}`,
      `source: ${yamlString(posix(path.relative(root, pkg.manifest)))}`,
      "editUrl: false",
      "---",
      "",
      "<!--",
      "  Generated by docs/scripts/generate-api-docs.mjs.",
      "  Do not edit generated files under .docs-build/.",
      "-->",
      "",
      `This package publishes the \`${pkg.binaryName ?? pkg.name}\` executable and has no Rust library API.`,
      "",
      `[Open the package guide](${withBase(`/packages/${pkg.slug}/`)})`,
      "",
    ].join("\n");
  }
  const rustdocRoute = withBase(`/rustdoc/${pkg.rustdocTarget}/index.html`);
  return [
    "---",
    `title: ${yamlString(`${pkg.name} Rust API`)}`,
    `description: ${yamlString(`Generated rustdoc API reference for ${pkg.name}.`)}`,
    `source: ${yamlString(posix(path.relative(root, pkg.manifest)))}`,
    "editUrl: false",
    "---",
    "",
    "<!--",
    "  Generated by docs/scripts/generate-api-docs.mjs.",
    "  Do not edit generated files under .docs-build/.",
    "-->",
    "",
    `The complete API reference is generated by Cargo from the crate's rustdoc comments.`,
    "",
    `[Open rustdoc for \`${pkg.name}\`](${rustdocRoute})`,
    "",
  ].join("\n");
}

function generateRustApis(packages) {
  if (packages.length === 0) return [];
  const libraryPackages = packages.filter((pkg) => pkg.hasLibrary);
  const targetRoot = path.join(root, ".docs-build", "rustdoc-target");
  const generatedRoot = path.join(targetRoot, "doc");
  const publishedRoot = path.join(publicRoot, "rustdoc");
  fs.rmSync(targetRoot, { force: true, recursive: true });
  fs.rmSync(publishedRoot, { force: true, recursive: true });
  if (libraryPackages.length > 0) {
    checkedSpawn(
      "cargo",
      [
        "doc",
        "--locked",
        "--no-deps",
        "--lib",
        "--target-dir",
        targetRoot,
        ...libraryPackages.flatMap((pkg) => ["--package", pkg.name]),
      ],
      "Rust API generation",
    );
    fs.cpSync(generatedRoot, publishedRoot, { recursive: true });
  }

  const generated = [];
  for (const pkg of packages) {
    if (pkg.hasLibrary) {
      const rustdocIndex = path.join(publishedRoot, pkg.rustdocTarget, "index.html");
      if (!fs.existsSync(rustdocIndex)) {
        throw new Error(`Cargo did not generate rustdoc for ${pkg.name}: ${rustdocIndex}`);
      }
    }
    write(path.join(apiRoot, pkg.slug, "index.md"), rustLandingPage(pkg));
    generated.push(pkg);
  }
  return generated;
}

function main() {
  if (!fs.existsSync(siteRoot)) {
    throw new Error("Missing .docs-build/site. Run docs/scripts/sync-readmes.mjs first.");
  }

  const typescriptPackages = discoverPackages();
  const pythonPackages = discoverPythonPackages();
  const rustPackages = discoverRustPackages();
  fs.rmSync(apiRoot, { recursive: true, force: true });
  fs.mkdirSync(apiRoot, { recursive: true });

  const generated = [];
  for (const pkg of typescriptPackages) {
    if (generatePackageApi(pkg)) generated.push(pkg);
  }
  for (const pkg of pythonPackages) {
    if (generatePythonPackageApi(pkg)) generated.push(pkg);
  }
  generated.push(...generateRustApis(rustPackages));

  write(
    path.join(apiRoot, "index.md"),
    buildApiIndex(
      generated.sort(
        (left, right) =>
          left.group.localeCompare(right.group) || left.name.localeCompare(right.name),
      ),
    ),
  );
  console.log(
    `Generated API docs for ${generated.length} packages into ${posix(path.relative(root, apiRoot))}`,
  );
}

main();
