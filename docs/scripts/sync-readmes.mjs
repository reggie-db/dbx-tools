#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { brand, project as coreProject } from "../../packages/js/node/core/index.ts";
import { loadDocsToolchain } from "./docs-toolchain.mjs";
import {
  discoverRepositoryPackages,
  groupTitle,
  posix,
  summaryText,
  withBasePath,
} from "./repository-docs.mjs";
import { docsSiteConfig } from "./site-config.mjs";

const root = process.cwd();
const sourceRoot = path.join(root, ".docs-build", "site");
const docsContentRoot = path.join(sourceRoot, "src", "content", "docs");
const publicRoot = path.join(sourceRoot, "public");
const repoUrl = coreProject.repositoryUrl(root);
if (!repoUrl) throw new Error("Could not resolve the repository URL");
const brandFile = path.join(root, "branding", "brand.yaml");
const brandContext = await brand.loadBrandContextFile(brandFile);
const docsToolchain = loadDocsToolchain(path.join(root, "docs", "toolchain.json"));
const { base, site } = docsSiteConfig();

// The route base must match the generated Astro config. Starlight auto-prefixes
// sidebar links and assets, but not absolute links in generated Markdown or
// llms files, so those go through `withBase`.
/** Prefix a site-absolute path (`/packages/x`) with the deployment {@link base}. */
function withBase(sitePath) {
  return withBasePath(base, sitePath);
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
      if (!fs.existsSync(abs)) {
        throw new Error(
          `Missing local README link target ${target} from ${posix(path.relative(root, fromDir)) || "."}`,
        );
      }
      const repoPath = posix(path.relative(root, abs));
      const view = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? "tree" : "blob";
      return `${open}${repoUrl}/${view}/main/${repoPath}${hash}${close}`;
    },
  );
}

function assertRustWorkspaceReadmeLinks(packages, mappings) {
  const rootReadme = path.join(root, "README.md");
  for (const pkg of packages.filter((candidate) => candidate.group === "rust")) {
    const source = read(pkg.readme);
    for (const match of source.matchAll(/\[workspace README\]\(([^)#]+)(#[^)]+)?\)/gi)) {
      const target = path.resolve(pkg.dir, match[1].trim());
      if (target !== rootReadme) {
        throw new Error(`Rust workspace README link must resolve to README.md: ${pkg.relDir}`);
      }
      const expected = `[workspace README](${withBase("/")}${match[2] ?? ""})`;
      const generated = transformLinks(match[0], pkg.dir, mappings);
      if (generated !== expected) {
        throw new Error(
          `Rust workspace README link generated ${generated}, expected ${expected}: ${pkg.relDir}`,
        );
      }
    }
  }
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
    // hand-written package guides first, then generated language API pages.
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
        "check-links": "node ../../docs/scripts/check-dist-links.mjs ../dist",
      },
      dependencies: docsToolchain,
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
        baseUrl: ${JSON.stringify(`${repoUrl}/edit/main/`)},
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
  const packages = discoverRepositoryPackages(root);
  const guides = discoverGuides();
  const mappings = { byDir: new Map(), byFile: new Map() };
  for (const pkg of packages) {
    mappings.byDir.set(path.resolve(pkg.dir), docsPathForPackage(pkg));
  }
  for (const guide of guides) {
    mappings.byFile.set(path.resolve(guide.source), docsPathForGuide(guide));
  }
  assertRustWorkspaceReadmeLinks(packages, mappings);

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
    const packagePage = generatedPage(pkg.readme, read(pkg.readme), pkg.name, pkg.dir, mappings);
    write(
      path.join(docsContentRoot, "packages", `${pkg.slug}.md`),
      `${packagePage.trimEnd()}\n\n## API Reference\n\n[Open the generated API reference](${withBase(`/api/${pkg.slug}/`)})\n`,
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
