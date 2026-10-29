#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import * as brandFiles from "../../packages/js/node/core/src/brand-files.ts";
import * as projectUtils from "../../packages/js/node/core/src/project-utils.ts";
import { brandUtils } from "@dbx-tools/shared-core";
import { docsAstroScript, loadDocsToolchain } from "./docs-toolchain.mjs";
import {
  discoverRepositoryPackages,
  groupTitle,
  packageReadmeIssues,
  posix,
  stripLeadingH1,
  summaryText,
  withBasePath,
  yamlString,
} from "./repository-docs.mjs";
import { docsSiteConfig } from "./site-config.mjs";

const root = process.cwd();
const sourceRoot = path.join(root, ".docs-build", "site");
const docsContentRoot = path.join(sourceRoot, "src", "content", "docs");
const publicRoot = path.join(sourceRoot, "public");
const repoUrl = projectUtils.repositoryUrl(root);
if (!repoUrl) throw new Error("Could not resolve the repository URL");
const brandFile = path.join(root, "branding", "brand.yaml");
const brandContext = await brandFiles.loadBrandContextFile(brandFile);
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

const GUIDE_ORDER = [
  "get-started-appkit",
  "agents-and-genie",
  "lakebox",
  "model-gateway",
  "memory-search-and-actions",
  "data-and-files",
  "cli-and-local-services",
];

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
    .sort((left, right) => {
      const leftIndex = GUIDE_ORDER.indexOf(left.slug);
      const rightIndex = GUIDE_ORDER.indexOf(right.slug);
      if (leftIndex >= 0 || rightIndex >= 0) {
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
      }
      return left.title.localeCompare(right.title);
    });
}

/** Release notes retained under `docs/releases`, newest version first. */
function discoverReleaseNotes() {
  const dir = path.join(root, "docs", "releases");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const source = path.join(dir, entry.name);
      const slug = entry.name.replace(/\.md$/, "");
      return {
        source,
        slug,
        title: pageTitle(read(source), slug),
      };
    })
    .sort((left, right) => right.slug.localeCompare(left.slug, undefined, { numeric: true }));
}

function docsPathForGuide(guide) {
  return `/guides/${guide.slug}`;
}

function docsPathForGuideIndex() {
  return "/guides/";
}

function docsPathForRelease(release) {
  return `/releases/${release.slug.replaceAll(".", "")}`;
}

function docsPathForReleaseIndex() {
  return "/releases/";
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

function buildGuideIndex(guides) {
  return [
    "Choose a task to start with dbx-tools.",
    "",
    ...guides.map((guide) => {
      const summary = summaryText(read(guide.source));
      return `- [${guide.title}](${withBase(docsPathForGuide(guide))})${summary ? `: ${summary}` : ""}`;
    }),
    "",
  ].join("\n");
}

function releaseSummary(markdown) {
  const prose = markdown
    .split(/\r?\n\r?\n/)
    .map((section) => section.trim())
    .find(
      (section) =>
        section &&
        !section.startsWith("#") &&
        !section.startsWith("```") &&
        !section.startsWith("|"),
    );
  return prose ? summaryText(`# Release\n\n${prose}`) : "";
}

function buildReleaseIndex(releases) {
  return [
    "Release notes describe user-visible changes for each dbx-tools version.",
    "",
    ...releases.map((release) => {
      const summary = releaseSummary(read(release.source));
      return `- [${release.title}](${withBase(docsPathForRelease(release))})${summary ? `: ${summary}` : ""}`;
    }),
    "",
  ].join("\n");
}

function nav(packages, guides, releases) {
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
            label: "Start here",
            items: [
              { label: "Overview", link: docsPathForGuideIndex() },
              ...guides.map((guide) => ({
                label: guide.title,
                link: docsPathForGuide(guide),
              })),
            ],
          },
        ]
      : []),
    { label: "Package reference", link: "/packages/" },
    ...[...groups.entries()].map(([group, items]) => ({
      label: groupTitle(group),
      items: items.map((item) => ({ label: item.text, link: item.link })),
    })),
    // API reference sorts after the README guides: readers reach the
    // hand-written package guides first, then generated language API pages.
    { label: "API reference", link: "/api/" },
    ...(releases.length
      ? [
          {
            label: "Release notes",
            link: docsPathForReleaseIndex(),
          },
        ]
      : []),
  ];
  return {
    sidebar,
  };
}

function llms(packages, guides, releases) {
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
  if (releases.length) {
    lines.push("## Release Notes", "");
    for (const release of releases) {
      const summary = releaseSummary(read(release.source));
      lines.push(`- [${release.title}](${withBase(docsPathForRelease(release))}): ${summary}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function llmsFull(packages, guides, releases, mappings) {
  const parts = [
    brandUtils.brandContextPrompt(brandContext),
    transformLinks(read(path.join(root, "README.md")), root, mappings),
  ];
  for (const guide of guides) {
    parts.push(transformLinks(read(guide.source), path.dirname(guide.source), mappings));
  }
  for (const pkg of packages) {
    parts.push(transformLinks(read(pkg.readme), pkg.dir, mappings));
  }
  for (const release of releases) {
    parts.push(transformLinks(read(release.source), path.dirname(release.source), mappings));
  }
  return parts.join("\n\n---\n\n");
}

function docsPackageJson() {
  return `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        dev: docsAstroScript("dev", "--host", "127.0.0.1"),
        build: docsAstroScript("build"),
        preview: docsAstroScript("preview", "--host", "127.0.0.1"),
        "check-links": "bun ../../docs/scripts/check-dist-links.mjs ../dist",
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
      components: {
        Head: "./src/components/Head.astro",
      },
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

@media (min-width: 50rem) {
  :root {
    --sl-sidebar-width: var(--dbx-sidebar-width, 20rem);
  }
}

/* Keep the current page the same weight so selecting it never re-wraps the label. */
.sidebar-content a[aria-current="page"],
.sidebar-content a[aria-current="page"]:hover,
.sidebar-content a[aria-current="page"]:focus {
  font-weight: inherit;
}

.sidebar-content a {
  overflow-wrap: anywhere;
}

.dbx-sidebar-resizer {
  display: none;
}

@media (min-width: 50rem) {
  .dbx-sidebar-resizer {
    display: block;
    position: fixed;
    z-index: calc(var(--sl-z-index-menu) + 1);
    inset-block: var(--sl-nav-height) 0;
    inset-inline-start: calc(var(--sl-sidebar-width) - 1px);
    width: 6px;
    cursor: col-resize;
    touch-action: none;
    background: transparent;
    outline: none;
  }

  /* No visible bar: hovering or dragging only darkens Starlight's own sidebar hairline. */
  :root:has(.dbx-sidebar-resizer:hover) .sidebar-pane,
  :root[data-dbx-sidebar-resizing] .sidebar-pane {
    border-inline-end-color: var(--sl-color-gray-4);
  }

  .dbx-sidebar-resizer:focus-visible {
    background: var(--sl-color-gray-5);
  }

  :root[data-dbx-sidebar-resizing] {
    cursor: col-resize;
    user-select: none;
  }
}

.mermaid-diagram {
  margin-block: 1.5rem;
  overflow-x: auto;
  text-align: center;
}

.mermaid-diagram svg {
  display: block;
  height: auto;
  margin-inline: auto;
  max-width: 100%;
}
`;
}

/** Mermaid theme variables derived from the brand palette for both color schemes. */
function mermaidThemes() {
  const { colors, typography } = brandContext;
  const shared = { fontFamily: typography.sans, fontSize: "13px" };
  return {
    light: {
      ...shared,
      background: colors.background,
      primaryColor: colors.surface,
      primaryTextColor: colors.foreground,
      primaryBorderColor: colors.muted,
      secondaryColor: colors.surface,
      tertiaryColor: colors.background,
      lineColor: colors.muted,
      textColor: colors.foreground,
      edgeLabelBackground: colors.background,
    },
    dark: {
      ...shared,
      darkMode: true,
      background: colors.foreground,
      primaryColor: colors.primary,
      primaryTextColor: colors.surface,
      primaryBorderColor: colors.muted,
      secondaryColor: colors.primary,
      tertiaryColor: colors.foreground,
      lineColor: colors.muted,
      textColor: colors.surface,
      edgeLabelBackground: colors.primary,
    },
  };
}

function mermaidHead() {
  return `---
import DefaultHead from "@astrojs/starlight/components/Head.astro";
---

<DefaultHead />

<script is:inline>
  (() => {
    try {
      const width = Number(localStorage.getItem("dbx-tools.sidebar-width"));
      if (width >= 256 && width <= 640) {
        document.documentElement.style.setProperty("--dbx-sidebar-width", width + "px");
      }
    } catch {}
  })();
</script>

<script>
  const sidebarKey = Symbol.for("dbx-tools.sidebar-resizer");
  if (!Reflect.get(window, sidebarKey)) {
    Reflect.set(window, sidebarKey, true);
    const storageKey = "dbx-tools.sidebar-width";
    const minWidth = 256;
    const maxWidth = 640;
    const step = 16;
    const root = document.documentElement;

    function currentWidth() {
      const pane = document.querySelector(".sidebar-pane");
      return pane instanceof HTMLElement ? pane.getBoundingClientRect().width : 320;
    }

    function applyWidth(width: number, persist: boolean) {
      const limit = Math.min(maxWidth, Math.max(minWidth, window.innerWidth * 0.5));
      const clamped = Math.round(Math.min(limit, Math.max(minWidth, width)));
      root.style.setProperty("--dbx-sidebar-width", clamped + "px");
      if (!persist) return;
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {}
    }

    function resetWidth() {
      root.style.removeProperty("--dbx-sidebar-width");
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }

    function mountResizer() {
      if (!document.querySelector(".sidebar-pane")) return;
      if (document.querySelector(".dbx-sidebar-resizer")) return;
      const handle = document.createElement("div");
      handle.className = "dbx-sidebar-resizer";
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", "Resize sidebar");
      handle.title = "Drag to resize. Double-click to reset.";

      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        root.dataset.dbxSidebarResizing = "";
        const move = (moveEvent: PointerEvent) => applyWidth(moveEvent.clientX, false);
        const end = (endEvent: PointerEvent) => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          delete root.dataset.dbxSidebarResizing;
          applyWidth(endEvent.clientX, true);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      });
      handle.addEventListener("dblclick", resetWidth);
      handle.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft") applyWidth(currentWidth() - step, true);
        else if (event.key === "ArrowRight") applyWidth(currentWidth() + step, true);
        else if (event.key === "Home" || event.key === "Escape") resetWidth();
        else return;
        event.preventDefault();
      });
      document.body.append(handle);
    }

    document.addEventListener("astro:page-load", mountResizer);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountResizer, { once: true });
    } else {
      mountResizer();
    }
  }
</script>

<script>
  const runtimeKey = Symbol.for("dbx-tools.mermaid-runtime");
  if (!Reflect.get(window, runtimeKey)) {
    Reflect.set(window, runtimeKey, true);
    const blockSelector = [
      'code.language-mermaid',
      '[data-language="mermaid"] code',
      'pre.language-mermaid code',
    ].join(",");
    const themes = ${JSON.stringify(mermaidThemes())};
    let mermaidPromise: Promise<typeof import("mermaid").default> | undefined;
    let renderQueue = Promise.resolve();

    function loadMermaid() {
      mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => mermaid);
      return mermaidPromise;
    }

    function sourceText(codeBlock: HTMLElement) {
      const expressiveCodeLines = codeBlock.querySelectorAll(".ec-line .code");
      if (expressiveCodeLines.length > 0) {
        return Array.from(expressiveCodeLines, (line) => line.textContent ?? "").join("\\n");
      }
      return codeBlock.textContent ?? "";
    }

    function prepareDiagrams() {
      const codeBlocks = new Set(document.querySelectorAll(blockSelector));
      for (const codeBlock of codeBlocks) {
        if (!(codeBlock instanceof HTMLElement)) continue;
        if (codeBlock.closest(".mermaid-diagram")) continue;
        const renderedBlock =
          codeBlock.closest("figure.expressive-code") ?? codeBlock.closest("pre");
        if (!renderedBlock) continue;
        const diagram = document.createElement("div");
        diagram.className = "mermaid-diagram";
        diagram.dataset.mermaidSource = sourceText(codeBlock);
        renderedBlock.replaceWith(diagram);
      }
    }

    async function renderDiagrams() {
      prepareDiagrams();
      const diagrams = Array.from(document.querySelectorAll(".mermaid-diagram"));
      if (diagrams.length === 0) return;
      const mermaid = await loadMermaid();
      const dark = document.documentElement.dataset.theme === "dark";
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        look: "classic",
        themeVariables: dark ? themes.dark : themes.light,
        minNodeWidth: 0,
        flowchart: {
          useMaxWidth: false,
          minNodeWidth: 0,
          nodeSpacing: 24,
          rankSpacing: 32,
          padding: 8,
        },
      });
      for (const diagram of diagrams) {
        if (!(diagram instanceof HTMLElement)) continue;
        const source = diagram.dataset.mermaidSource;
        if (!source) continue;
        diagram.replaceChildren(document.createTextNode(source));
        diagram.removeAttribute("data-processed");
      }
      await mermaid.run({ nodes: diagrams });
    }

    function queueRender() {
      renderQueue = renderQueue.then(renderDiagrams, renderDiagrams).catch((error) => {
        console.error("Failed to render Mermaid diagrams", error);
      });
    }

    document.addEventListener("astro:page-load", queueRender);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", queueRender, { once: true });
    } else {
      queueRender();
    }

    new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === "data-theme")) queueRender();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
</script>
`;
}

function syncBrandAssets() {
  const assetRoot = path.join(sourceRoot, "src", "assets");
  const copyAsset = (source, destination) => {
    const resolved = brandFiles.resolveBrandAssetPath(brandFile, source);
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
    `${JSON.stringify(brandUtils.brandContextJsonSchema(), null, 2)}\n`,
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
  for (const pkg of packages) {
    const issues = packageReadmeIssues(read(pkg.readme));
    if (issues.length > 0) {
      throw new Error(`${pkg.relDir}/README.md: ${issues.join("; ")}`);
    }
  }
  const guides = discoverGuides();
  const releases = discoverReleaseNotes();
  const mappings = { byDir: new Map(), byFile: new Map() };
  for (const pkg of packages) {
    mappings.byDir.set(path.resolve(pkg.dir), docsPathForPackage(pkg));
  }
  for (const guide of guides) {
    mappings.byFile.set(path.resolve(guide.source), docsPathForGuide(guide));
  }
  for (const release of releases) {
    mappings.byFile.set(path.resolve(release.source), docsPathForRelease(release));
  }
  mappings.byDir.set(path.join(root, "packages"), "/packages/");
  mappings.byDir.set(path.join(root, "docs"), docsPathForGuideIndex());
  mappings.byDir.set(path.join(root, "docs", "releases"), docsPathForReleaseIndex());
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
      title: "Package reference",
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
      `${packagePage.trimEnd()}\n\n## See more\n\n[Open the complete API reference](${withBase(`/api/${pkg.slug}/`)})\n`,
    );
  }

  if (guides.length) {
    const guideIndexSource = path.join(root, "docs", "README.md");
    write(
      path.join(docsContentRoot, "guides", "index.md"),
      frontmatter({
        title: "Start here",
        description: "Task-based guides for building with dbx-tools.",
        sourcePath: guideIndexSource,
      }) +
        generatedHeader(guideIndexSource) +
        buildGuideIndex(guides),
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

  if (releases.length) {
    const releaseIndexSource = path.join(root, "docs", "scripts", "sync-readmes.mjs");
    write(
      path.join(docsContentRoot, "releases", "index.md"),
      frontmatter({
        title: "Release notes",
        description: "User-visible changes in dbx-tools releases.",
        sourcePath: releaseIndexSource,
      }) +
        generatedHeader(releaseIndexSource) +
        buildReleaseIndex(releases),
    );
  }

  for (const release of releases) {
    write(
      path.join(docsContentRoot, "releases", `${release.slug.replaceAll(".", "")}.md`),
      generatedPage(
        release.source,
        read(release.source),
        release.title,
        path.dirname(release.source),
        mappings,
      ),
    );
  }

  write(
    path.join(sourceRoot, "nav.json"),
    `${JSON.stringify(nav(packages, guides, releases), null, 2)}\n`,
  );
  write(path.join(sourceRoot, "package.json"), docsPackageJson());
  write(path.join(sourceRoot, "pnpm-workspace.yaml"), docsWorkspaceYaml());
  write(path.join(sourceRoot, "astro.config.mjs"), astroConfig());
  write(path.join(sourceRoot, "src", "components", "Head.astro"), mermaidHead());
  write(path.join(sourceRoot, "src", "content.config.ts"), contentConfig());
  syncBrandAssets();

  const titleCheck = path.join(root, "docs", "scripts", "check-generated-titles.mjs");
  const result = Bun.spawnSync([process.execPath, titleCheck], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
  write(path.join(publicRoot, "llms.txt"), llms(packages, guides, releases));
  write(path.join(publicRoot, "llms-full.txt"), llmsFull(packages, guides, releases, mappings));
  // Disable Jekyll on GitHub Pages so Astro's `_astro/` asset dir (underscore
  // prefix) is served instead of stripped. Astro copies `public/*` to dist root.
  write(path.join(publicRoot, ".nojekyll"), "");
  console.log(
    `Generated docs from ${packages.length} package READMEs, ${guides.length} guides, and ${releases.length} release notes into ${posix(path.relative(root, sourceRoot))}`,
  );
}

main();
