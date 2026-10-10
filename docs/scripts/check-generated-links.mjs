#!/usr/bin/env bun
/** Validate internal routes and fragments directly from generated Markdown. */
import fs from "node:fs";
import path from "node:path";
import { lexer, walkTokens } from "marked";
import { posix, walk } from "./repository-docs.mjs";
import { docsSiteConfig } from "./site-config.mjs";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const HTML_LINK = /\b(?:href|src)=["']([^"']+)["']/gi;
const EXPLICIT_FRAGMENT = /\b(?:id|name)=["']([^"']+)["']/gi;
const PUNCTUATION = /[\u2000-\u206f\u2e00-\u2e7f\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g;

function routeForFile(contentRoot, file) {
  const relative = posix(path.relative(contentRoot, file)).replace(/\.(?:md|mdx)$/i, "");
  if (relative === "index") return "/";
  if (relative.endsWith("/index")) return `/${relative.slice(0, -"index".length)}`;
  return `/${relative}/`;
}

function normalizedRoute(route) {
  if (route === "/") return route;
  return `${route.replace(/\.(?:md|mdx)$/i, "").replace(/\/+$/, "")}/`;
}

function stripBase(pathname, base) {
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

function headingText(token) {
  if (!Array.isArray(token.tokens)) return token.text ?? "";
  return token.tokens
    .map((part) => {
      if (part.type === "image") return part.text ?? "";
      if (Array.isArray(part.tokens)) return headingText(part);
      return part.text ?? part.raw ?? "";
    })
    .join("");
}

function slug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[!/a-z].*?>/gi, "")
    .replace(PUNCTUATION, "")
    .replace(/\s/g, "-");
}

function fragments(markdown) {
  const values = new Set();
  const occurrences = new Map();
  for (const token of lexer(markdown)) {
    if (token.type !== "heading") continue;
    const base = slug(headingText(token));
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    values.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  for (const match of markdown.matchAll(EXPLICIT_FRAGMENT)) values.add(match[1]);
  return values;
}

function links(markdown) {
  const values = [];
  const tokens = lexer(markdown);
  walkTokens(tokens, (token) => {
    if ((token.type === "link" || token.type === "image") && token.href) {
      values.push(token.href.replaceAll("&amp;", "&"));
    }
  });
  for (const match of markdown.matchAll(HTML_LINK)) {
    values.push(match[1].replaceAll("&amp;", "&"));
  }
  return values;
}

function addRouteAliases(routes, contentRoot, file, page) {
  const route = routeForFile(contentRoot, file);
  routes.set(normalizedRoute(route), page);
  const sourcePath = `/${posix(path.relative(contentRoot, file))}`;
  routes.set(sourcePath, page);
}

function assetRoutes(siteRoot) {
  const publicRoot = path.join(siteRoot, "public");
  if (!fs.existsSync(publicRoot)) return new Set();
  return new Set(walk(publicRoot).map((file) => `/${posix(path.relative(publicRoot, file))}`));
}

/** Return broken generated documentation links without building HTML. */
export function generatedLinkFailures(siteRoot, options = {}) {
  const contentRoot = path.join(siteRoot, "src", "content", "docs");
  if (!fs.existsSync(contentRoot)) throw new Error(`Missing generated docs: ${contentRoot}`);
  const { base } = docsSiteConfig();
  const pages = walk(contentRoot)
    .filter((file) => MARKDOWN_EXTENSIONS.has(path.extname(file)))
    .map((file) => {
      const markdown = fs.readFileSync(file, "utf8");
      return { file, markdown, fragments: fragments(markdown) };
    });
  const routes = new Map();
  for (const page of pages) addRouteAliases(routes, contentRoot, page.file, page);
  if (options.allowApiStubs) {
    for (const route of routes.keys()) {
      const match = route.match(/^\/packages\/([^/]+)\/$/);
      if (match) routes.set(`/api/${match[1]}/`, { fragments: undefined });
    }
    routes.set("/api/", { fragments: undefined });
  }
  const assets = assetRoutes(siteRoot);
  const failures = [];
  for (const page of pages) {
    const source = posix(path.relative(contentRoot, page.file));
    const sourceRoute = routeForFile(contentRoot, page.file);
    for (const link of links(page.markdown)) {
      if (!link || link.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(link)) continue;
      const resolved = new URL(link, `https://static.invalid${sourceRoute}`);
      const pathname = decodeURIComponent(stripBase(resolved.pathname, base));
      const target = routes.get(pathname) ?? routes.get(normalizedRoute(pathname));
      if (!target && !assets.has(pathname)) {
        failures.push(`${source}: ${link} has no generated target`);
        continue;
      }
      if (target?.fragments && resolved.hash.length > 1) {
        const fragment = decodeURIComponent(resolved.hash.slice(1));
        if (!target.fragments.has(fragment)) {
          failures.push(`${source}: ${link} has no matching generated fragment`);
        }
      }
    }
  }
  return { checkedPages: pages.length, failures };
}

function main() {
  const args = process.argv.slice(2);
  const allowApiStubs = args.includes("--allow-api-stubs");
  const directory = args.find((arg) => !arg.startsWith("--")) ?? ".docs-build/site";
  const siteRoot = path.resolve(directory);
  const result = generatedLinkFailures(siteRoot, { allowApiStubs });
  if (result.failures.length > 0) {
    throw new Error(`Broken generated documentation links:\n${result.failures.join("\n")}`);
  }
  process.stderr.write(
    `Validated ${result.checkedPages} generated Markdown pages without building HTML.\n`,
  );
}

if (import.meta.main) main();
