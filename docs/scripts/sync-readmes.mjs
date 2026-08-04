#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { brand } from "../../packages/js/node/core/index.ts";

const root = process.cwd();
const sourceRoot = path.join(root, ".docs-build", "site");
const docsContentRoot = path.join(sourceRoot, "src", "content", "docs");
const publicRoot = path.join(sourceRoot, "public");
const repoUrl = "https://github.com/reggie-db/dbx-tools";
const brandFile = path.join(root, "branding", "brand.yaml");
const brandContext = await brand.loadBrandContextFile(brandFile);

// Base path the site is served under. Must match `base` in the generated
// astro.config.mjs. Starlight auto-prefixes this onto sidebar `link:` fields
// and built assets, but NOT onto absolute links inside generated markdown
// bodies or the plain-text llms files, so those go through `withBase`.
const base = process.env.GITHUB_REPOSITORY?.endsWith("/dbx-tools") ? "/dbx-tools" : "";

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

function packageGroup(pkgPath) {
  const [, group] = posix(pkgPath).split("/");
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

function docsPathForPackage(pkg) {
  return `/packages/${pkg.slug}`;
}

function pageTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || fallback;
}

function stripLeadingH1(markdown) {
  return markdown.replace(/^#\s+.+?(?:\r?\n)+/, "");
}

function yamlString(value) {
  return JSON.stringify(value ?? "");
}

function frontmatter({ title, description, sourcePath }) {
  return `${[
    "---",
    `title: ${yamlString(title)}`,
    description ? `description: ${yamlString(description)}` : undefined,
    `source: ${yamlString(posix(path.relative(root, sourcePath)))}`,
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
      return `${open}${repoUrl}/blob/main/${repoPath}${hash}${close}`;
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
      description: firstParagraph(markdown),
      sourcePath,
    }) +
    generatedHeader(sourcePath) +
    transformLinks(stripLeadingH1(markdown), fromDir, mappings)
  );
}

function buildPackageIndex(packages) {
  const rows = packages
    .map((pkg) => {
      const summary = (firstParagraph(read(pkg.readme)) ?? "").replace(/\|/g, "\\|");
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
      const summary = firstParagraph(read(guide.source)) ?? "";
      lines.push(`- [${guide.title}](${withBase(docsPathForGuide(guide))}): ${summary}`);
    }
    lines.push("");
  }
  lines.push("## Packages", "");
  for (const pkg of packages) {
    const summary = firstParagraph(read(pkg.readme)) ?? "";
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
      },
      dependencies: {
        "@astrojs/starlight": "^0.41.0",
        astro: "^7.0.0",
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
  site: "https://reggie-db.github.io",
  base: process.env.GITHUB_REPOSITORY?.endsWith("/dbx-tools") ? "/dbx-tools" : "/",
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
  const packages = discoverPackages();
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
