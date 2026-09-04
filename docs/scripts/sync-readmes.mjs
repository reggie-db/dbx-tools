#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { brand } from "../../packages/js/node/core/index.ts";
import { docsSiteConfig } from "./site-config.mjs";

const root = process.cwd();
const sourceRoot = path.join(root, ".docs-build", "site");
const docsContentRoot = path.join(sourceRoot, "src", "content", "docs");
const publicRoot = path.join(sourceRoot, "public");
const repoUrl = "https://github.com/reggie-db/dbx-tools";
const brandFile = path.join(root, "branding", "brand.yaml");
const brandContext = await brand.loadBrandContextFile(brandFile);
const { base, site } = docsSiteConfig();

// The route base must match the generated Astro config. Starlight auto-prefixes
// sidebar links and assets, but not absolute links in generated Markdown or
// llms files, so those go through `withBase`.
/** Prefix a site-absolute path (`/packages/x`) with the deployment {@link base}. */
function withBase(sitePath) {
  if (!sitePath.startsWith("/")) return sitePath;
  if (base && (sitePath === base || sitePath.startsWith(`${base}/`))) return sitePath;
  return `${base}${sitePath}`;
}

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
/**
 * Content fenced off as GitHub-only. A README is both the repo landing page and
 * the source of a generated page here, so anything that only makes sense on
 * GitHub - the link TO this site, most obviously - is fenced rather than
 * duplicated into the site as a self-reference.
 */
const DOCS_IGNORE =
  /[ \t]*<!--\s*docs-site:ignore:start\s*-->[\s\S]*?<!--\s*docs-site:ignore:end\s*-->[ \t]*\n*/g;

const read = (p) => fs.readFileSync(p, "utf8").replace(DOCS_IGNORE, "");
const write = (p, text) => {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, text);
};

const posix = (p) => p.split(path.sep).join("/");

function packageSlug(name) {
  return name
    .replace(/^@dbx-tools\//, "")
    .replace(/^@/, "")
    .replace(/\//g, "-");
}

/**
 * The `<group>` of a repo-relative `packages/js/<group>/<pkg>` path - the tier
 * (`node`, `shared`, `cli`, `ui`) the sidebar groups by, NOT the `js` language
 * segment that precedes it.
 */
function packageGroup(pkgPath) {
  const [, , group] = posix(pkgPath).split("/");
  return group ?? "other";
}

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

/**
 * Every PUBLISHED package under `packages/js/`, as the site's page set.
 *
 * A `private: true` manifest is skipped: it never reaches npm, so a page for it
 * documents something a reader cannot install. That also relaxes the
 * missing-README throw below to the packages it should apply to - an unpublished
 * spike is allowed to have no docs, a published package is not.
 */
function discoverPackages() {
  return walk(path.join(root, "packages/js"))
    .filter((p) => path.basename(p) === "package.json")
    .filter((packageJson) => JSON.parse(read(packageJson)).private !== true)
    .map((packageJson) => {
      const pkg = JSON.parse(read(packageJson));
      const dir = path.dirname(packageJson);
      const readme = path.join(dir, "README.md");
      if (!fs.existsSync(readme)) {
        throw new Error(`Missing README for ${pkg.name} at ${posix(path.relative(root, dir))}`);
      }
      return {
        name: pkg.name,
        dir,
        readme,
        relDir: posix(path.relative(root, dir)),
        group: packageGroup(path.relative(root, dir)),
        slug: packageSlug(pkg.name),
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/**
 * Every package under `packages/py/`, as site pages alongside the JavaScript
 * ones.
 *
 * They are published to GitHub rather than npm and installed by Git URL, so the
 * distribution name comes out of `pyproject.toml` instead of a `package.json`.
 * The layout is flat (`packages/py/<name>`, no tier segment), which is why they
 * all share one `python` group rather than reusing {@link packageGroup}.
 */
function discoverPythonPackages() {
  const dir = path.join(root, "packages/py");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => path.join(dir, ent.name))
    .filter((pkgDir) => fs.existsSync(path.join(pkgDir, "pyproject.toml")))
    .filter((pkgDir) => !pythonPrivate(path.join(pkgDir, "pyproject.toml")))
    .map((pkgDir) => {
      const readme = path.join(pkgDir, "README.md");
      const relDir = posix(path.relative(root, pkgDir));
      if (!fs.existsSync(readme)) {
        throw new Error(`Missing README for ${relDir}`);
      }
      const name = pythonDistribution(path.join(pkgDir, "pyproject.toml")) ?? path.basename(pkgDir);
      return {
        name,
        dir: pkgDir,
        readme,
        relDir,
        group: "python",
        slug: `py-${path.basename(pkgDir)}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every publishable Cargo package under `packages/rs/`. */
function discoverRustPackages() {
  const dir = path.join(root, "packages", "rs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => path.join(dir, ent.name))
    .filter((pkgDir) => fs.existsSync(path.join(pkgDir, "Cargo.toml")))
    .filter((pkgDir) => !rustPrivate(path.join(pkgDir, "Cargo.toml")))
    .map((pkgDir) => {
      const manifest = path.join(pkgDir, "Cargo.toml");
      const readme = path.join(pkgDir, "README.md");
      const relDir = posix(path.relative(root, pkgDir));
      if (!fs.existsSync(readme)) throw new Error(`Missing README for ${relDir}`);
      const name = cargoPackageName(manifest) ?? path.basename(pkgDir);
      return {
        name,
        dir: pkgDir,
        readme,
        relDir,
        group: "rust",
        slug: `rs-${path.basename(pkgDir)}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cargoPackageName(manifest) {
  const section = read(manifest).match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return section.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
}

function rustPrivate(manifest) {
  const section = read(manifest).match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return /^\s*publish\s*=\s*false\s*$/m.test(section);
}

/** The `[project] name` of a `pyproject.toml`, read without a TOML parser. */
function pythonDistribution(pyproject) {
  const match = read(pyproject).match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return match?.[1];
}

/** Whether `[tool.dbx-tools] private = true` marks a Python package unpublished. */
function pythonPrivate(pyproject) {
  const source = read(pyproject);
  const section = source.match(/^\[tool\.dbx-tools\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  return /^\s*private\s*=\s*true\s*$/m.test(section);
}

/**
 * Hand-written contributor guides that live in `docs/*.md` (not package
 * READMEs). Published under `/guides/<slug>` so the site carries them
 * alongside the generated package reference.
 */
function discoverGuides() {
  const dir = path.join(root, "docs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((ent) => ent.isFile() && ent.name.endsWith(".md") && ent.name !== "README.md")
    .map((ent) => {
      const source = path.join(dir, ent.name);
      return {
        source,
        slug: ent.name.replace(/\.md$/, ""),
        title: pageTitle(read(source), ent.name),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function docsPathForGuide(guide) {
  return `/guides/${guide.slug}`;
}

function firstParagraph(markdown) {
  const withoutTitle = markdown.replace(/^# .*(\r?\n)+/, "");
  return withoutTitle
    .split(/\r?\n\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("```") && !s.startsWith("|"))
    ?.replace(/\s+/g, " ");
}

/** Plain prose for package indexes and llms summaries. */
function summaryText(markdown) {
  return (firstParagraph(markdown) ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

function docsPathForPackage(pkg) {
  return `/packages/${pkg.slug}`;
}

function plainTitle(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, "$1")
    .trim();
}

function pageTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return plainTitle(match?.[1] ?? fallback) || fallback;
}

function stripLeadingH1(markdown) {
  return markdown.replace(/^#\s+.+?(?:\r?\n)+/, "");
}

function yamlString(value) {
  return JSON.stringify(value ?? "");
}

function frontmatter({ title, description, sourcePath }) {
  if (title !== plainTitle(title)) {
    throw new Error(`Docs title must be plain text: ${title} (${sourcePath})`);
  }
  const source = posix(path.relative(root, sourcePath));
  return `${[
    "---",
    `title: ${yamlString(title)}`,
    description ? `description: ${yamlString(description)}` : undefined,
    `source: ${yamlString(source)}`,
    `editUrl: ${yamlString(`${repoUrl}/edit/main/${source}`)}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n")}\n\n`;
}

function localDocsTarget(absTarget, mappings) {
  const clean = absTarget.replace(/[/\\]$/, "");
  const guideDoc = mappings.byFile?.get(path.resolve(clean));
  if (guideDoc) return guideDoc;
  const statTarget = fs.existsSync(clean) ? clean : undefined;
  const asDir = statTarget && fs.statSync(statTarget).isDirectory() ? clean : path.dirname(clean);
  const packageDoc = mappings.byDir.get(path.resolve(asDir));
  if (packageDoc) return packageDoc;
  if (path.resolve(clean) === path.join(root, "README.md")) return "/";
  return undefined;
}

function transformLinks(markdown, fromDir, mappings) {
  return markdown.replace(
    /(\[[^\]]+\]\()([^)#]+)?(#[^)]+)?(\))/g,
    (match, open, rawTarget = "", hash = "", close) => {
      const target = rawTarget.trim();
      if (
        !target ||
        target.startsWith("http:") ||
        target.startsWith("https:") ||
        target.startsWith("mailto:") ||
        target.startsWith("/")
      ) {
        return match;
      }
      const abs = path.resolve(fromDir, target);
      const docsTarget = localDocsTarget(abs, mappings);
      if (docsTarget) return `${open}${withBase(docsTarget)}${hash}${close}`;
      const repoPath = posix(path.relative(root, abs));
      const view = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "tree" : "blob";
      return `${open}${repoUrl}/${view}/main/${repoPath}${hash}${close}`;
    },
  );
}

function generatedHeader(sourcePath) {
  return [
    "<!--",
    "  Generated by docs/scripts/sync-readmes.mjs.",
    `  Source: ${posix(path.relative(root, sourcePath))}`,
    "  Do not edit generated files under .docs-build/.",
    "-->",
    "",
  ].join("\n");
}

function generatedPage(sourcePath, markdown, fallbackTitle, fromDir, mappings) {
  return (
    frontmatter({
      title: pageTitle(markdown, fallbackTitle),
      description: summaryText(markdown),
      sourcePath,
    }) +
    generatedHeader(sourcePath) +
    transformLinks(stripLeadingH1(markdown), fromDir, mappings)
  );
}

function buildPackageIndex(packages) {
  const rows = packages
    .map((pkg) => {
      const summary = summaryText(read(pkg.readme)).replace(/\|/g, "\\|");
      return `| [${pkg.name}](${withBase(docsPathForPackage(pkg))}) | ${groupTitle(pkg.group)} | ${summary} |`;
    })
    .join("\n");
  return [
    "These pages are generated from package READMEs. Edit the package README, then rerun the docs generator.",
    "",
    "| Package | Area | Summary |",
    "| --- | --- | --- |",
    rows,
    "",
  ].join("\n");
}

function nav(packages, guides) {
  const groups = new Map();
  for (const pkg of packages) {
    const items = groups.get(pkg.group) ?? [];
    items.push({
      text: pkg.name,
      link: docsPathForPackage(pkg),
    });
    groups.set(pkg.group, items);
  }
  const sidebar = [
    { label: "Overview", link: "/" },
    ...(guides.length
      ? [
          {
            label: "Guides",
            items: guides.map((guide) => ({
              label: guide.title,
              link: docsPathForGuide(guide),
            })),
          },
        ]
      : []),
    { label: "Package Reference", link: "/packages/" },
    ...[...groups.entries()].map(([group, items]) => ({
      label: groupTitle(group),
      items: items.map((item) => ({ label: item.text, link: item.link })),
    })),
    // API reference sorts after the README guides: readers reach the
    // hand-written package guides first, then the generated TypeScript API.
    { label: "API Reference", link: "/api/" },
  ];
  return {
    sidebar,
  };
}

function llms(packages, guides) {
  const lines = [
    `# ${brandContext.name}`,
    "",
    `> ${brandContext.description}`,
    "",
    "## Docs",
    "",
    `- [Overview](${withBase("/")})`,
    `- [Package Reference](${withBase("/packages/")})`,
    `- [Brand Context](${withBase("/brand.json")})`,
    `- [Brand Context JSON Schema](${withBase("/brand.schema.json")})`,
    "",
  ];
  if (guides.length) {
    lines.push("## Guides", "");
    for (const guide of guides) {
      const summary = summaryText(read(guide.source));
      lines.push(`- [${guide.title}](${withBase(docsPathForGuide(guide))}): ${summary}`);
    }
    lines.push("");
  }
  lines.push("## Packages", "");
  for (const pkg of packages) {
    const summary = summaryText(read(pkg.readme));
    lines.push(`- [${pkg.name}](${withBase(docsPathForPackage(pkg))}): ${summary}`);
  }
  lines.push("");
  return lines.join("\n");
}

function llmsFull(packages, guides, mappings) {
  const parts = [
    brand.brandContextPrompt(brandContext),
    transformLinks(read(path.join(root, "README.md")), root, mappings),
  ];
  for (const guide of guides) {
    parts.push(transformLinks(read(guide.source), path.dirname(guide.source), mappings));
  }
  for (const pkg of packages) {
    parts.push(transformLinks(read(pkg.readme), pkg.dir, mappings));
  }
  return parts.join("\n\n---\n\n");
}

function docsPackageJson() {
  return `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        dev: "astro dev --host 127.0.0.1",
        build: "astro build",
        "check-links":
          "linkinator ../dist --recurse --directory-listing --clean-urls --concurrency 20 --timeout 10000 --retry-errors --skip 'dbx\\.tools' --status-code '429:warn'",
      },
      dependencies: {
        "@astrojs/starlight": "^0.41.0",
        astro: "^7.0.0",
        linkinator: "^8.0.3",
        typedoc: "^0.28.20",
        "typedoc-plugin-markdown": "^4.12.0",
      },
      devDependencies: {},
      pnpm: {
        onlyBuiltDependencies: ["esbuild", "sharp"],
      },
    },
    null,
    2,
  )}\n`;
}

function astroConfig() {
  return `// @ts-check
import fs from "node:fs";
import path from "node:path";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const docsRoot = process.cwd();
const repoRoot = path.resolve(docsRoot, "..", "..");
const navPath = path.join(docsRoot, "nav.json");
const generatedNav = fs.existsSync(navPath)
  ? JSON.parse(fs.readFileSync(navPath, "utf8"))
  : { sidebar: [] };

export default defineConfig({
  outDir: path.join(repoRoot, ".docs-build", "dist"),
  site: ${JSON.stringify(site)},
  base: ${JSON.stringify(base || "/")},
  integrations: [
    starlight({
      title: ${JSON.stringify(brandContext.name)},
      description: ${JSON.stringify(brandContext.description)},
      logo: {
        light: "./src/assets/brand-logo-light.svg",
        dark: "./src/assets/brand-logo-dark.svg",
        replacesTitle: true,
      },
      favicon: ${JSON.stringify(withBase("/brand-favicon.svg"))},
      customCss: ["./src/styles/brand.css"],
      sidebar: generatedNav.sidebar,
      social: [{ icon: "github", label: "GitHub", href: ${JSON.stringify(brandContext.links.repository ?? repoUrl)} }],
      editLink: {
        baseUrl: "https://github.com/reggie-db/dbx-tools/edit/main/",
      },
      pagefind: true,
    }),
  ],
});
`;
}

function brandCss() {
  const { colors, typography } = brandContext;
  return `:root {
  --dbx-brand-primary: ${colors.primary};
  --dbx-brand-primary-hover: ${colors.primaryHover};
  --dbx-brand-accent: ${colors.accent};
  --dbx-brand-foreground: ${colors.foreground};
  --dbx-brand-background: ${colors.background};
  --dbx-brand-surface: ${colors.surface};
  --dbx-brand-muted: ${colors.muted};
  --dbx-brand-border: ${colors.border};
  --sl-font: ${typography.sans};
  --sl-font-mono: ${typography.mono};
  --sl-color-accent-low: color-mix(in srgb, ${colors.primary} 14%, ${colors.background});
  --sl-color-accent: ${colors.primary};
  --sl-color-accent-high: ${colors.primaryHover};
}

:root[data-theme="dark"] {
  --sl-color-accent-low: color-mix(in srgb, ${colors.primary} 18%, ${colors.foreground});
  --sl-color-accent: ${colors.primary};
  --sl-color-accent-high: #ffffff;
}

.site-title img {
  width: auto;
  height: 2rem;
}

a:not([class]) {
  text-decoration-color: color-mix(in srgb, ${colors.accent} 65%, transparent);
}
`;
}

function syncBrandAssets() {
  const assetRoot = path.join(sourceRoot, "src", "assets");
  const copyAsset = (source, destination) => {
    const resolved = brand.resolveBrandAssetPath(brandFile, source);
    mkdir(path.dirname(destination));
    fs.copyFileSync(resolved, destination);
  };

  copyAsset(brandContext.assets.logo.light, path.join(assetRoot, "brand-logo-light.svg"));
  copyAsset(
    brandContext.assets.logo.dark ?? brandContext.assets.logo.light,
    path.join(assetRoot, "brand-logo-dark.svg"),
  );
  copyAsset(brandContext.assets.favicon, path.join(publicRoot, "brand-favicon.svg"));
  write(path.join(sourceRoot, "src", "styles", "brand.css"), brandCss());
  write(path.join(publicRoot, "brand.json"), `${JSON.stringify(brandContext, null, 2)}\n`);
  write(
    path.join(publicRoot, "brand.schema.json"),
    `${JSON.stringify(brand.brandContextJsonSchema(), null, 2)}\n`,
  );
}

function docsWorkspaceYaml() {
  return [
    "packages: []",
    "onlyBuiltDependencies:",
    "  - esbuild",
    "  - sharp",
    "allowBuilds:",
    "  esbuild: true",
    "  sharp: true",
    "",
  ].join("\n");
}

function contentConfig() {
  return `import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema(),
  }),
};
`;
}

function main() {
  const packages = [...discoverPackages(), ...discoverPythonPackages(), ...discoverRustPackages()];
  const guides = discoverGuides();
  const mappings = { byDir: new Map(), byFile: new Map() };
  for (const pkg of packages) {
    mappings.byDir.set(path.resolve(pkg.dir), docsPathForPackage(pkg));
  }
  for (const guide of guides) {
    mappings.byFile.set(path.resolve(guide.source), docsPathForGuide(guide));
  }

  rm(sourceRoot);
  mkdir(docsContentRoot);

  const rootReadme = path.join(root, "README.md");
  write(
    path.join(docsContentRoot, "index.md"),
    generatedPage(rootReadme, read(rootReadme), "dbx-tools", root, mappings),
  );
  write(
    path.join(docsContentRoot, "packages", "index.md"),
    frontmatter({
      title: "Package Reference",
      description: "Package-level documentation generated from dbx-tools README files.",
      sourcePath: rootReadme,
    }) +
      generatedHeader(rootReadme) +
      buildPackageIndex(packages),
  );

  for (const pkg of packages) {
    write(
      path.join(docsContentRoot, "packages", `${pkg.slug}.md`),
      generatedPage(pkg.readme, read(pkg.readme), pkg.name, pkg.dir, mappings),
    );
  }

  for (const guide of guides) {
    write(
      path.join(docsContentRoot, "guides", `${guide.slug}.md`),
      generatedPage(
        guide.source,
        read(guide.source),
        guide.title,
        path.dirname(guide.source),
        mappings,
      ),
    );
  }

  write(path.join(sourceRoot, "nav.json"), `${JSON.stringify(nav(packages, guides), null, 2)}\n`);
  write(path.join(sourceRoot, "package.json"), docsPackageJson());
  write(path.join(sourceRoot, "pnpm-workspace.yaml"), docsWorkspaceYaml());
  write(path.join(sourceRoot, "astro.config.mjs"), astroConfig());
  write(path.join(sourceRoot, "src", "content.config.ts"), contentConfig());
  syncBrandAssets();

  const titleCheck = path.join(root, "docs", "scripts", "check-generated-titles.mjs");
  const result = Bun.spawnSync([process.execPath, titleCheck], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  write(path.join(publicRoot, "llms.txt"), llms(packages, guides));
  write(path.join(publicRoot, "llms-full.txt"), llmsFull(packages, guides, mappings));
  // Disable Jekyll on GitHub Pages so Astro's `_astro/` asset dir (underscore
  // prefix) is served instead of stripped. Astro copies `public/*` to dist root.
  write(path.join(publicRoot, ".nojekyll"), "");
  console.log(
    `Generated docs from ${packages.length} package READMEs and ${guides.length} guides into ${posix(path.relative(root, sourceRoot))}`,
  );
}

main();
