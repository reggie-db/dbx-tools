#!/usr/bin/env node
/** Validate built internal routes and fragments directly from the static dist tree. */
import fs from "node:fs";
import path from "node:path";
import { docsSiteConfig } from "./site-config.mjs";

const distRoot = path.resolve(process.argv[2] ?? ".docs-build/dist");
const { base } = docsSiteConfig();

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else files.push(file);
  }
  return files;
}

function posix(file) {
  return file.split(path.sep).join("/");
}

function sourceRoute(file) {
  const relative = posix(path.relative(distRoot, file));
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) return `/${relative.slice(0, -"index.html".length)}`;
  return `/${relative}`;
}

function stripBase(pathname) {
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
}

function targetFile(pathname, files) {
  const relative = decodeURIComponent(stripBase(pathname)).replace(/^\/+/, "").replace(/\/+$/, "");
  for (const candidate of [
    relative || "index.html",
    `${relative}.html`,
    `${relative}/index.html`,
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

function links(html) {
  return [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map((match) =>
    match[1].replaceAll("&amp;", "&"),
  );
}

function fragmentExists(html, fragment) {
  const decoded = decodeURIComponent(fragment);
  return new RegExp(`\\b(?:id|name)=["']${escapeRegExp(decoded)}["']`).test(html);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  if (!fs.existsSync(distRoot)) throw new Error(`Missing docs output: ${distRoot}`);
  const builtFiles = walk(distRoot);
  const files = new Set(builtFiles.map((file) => posix(path.relative(distRoot, file))));
  const html = new Map(
    builtFiles
      .filter((file) => file.endsWith(".html"))
      .map((file) => [posix(path.relative(distRoot, file)), fs.readFileSync(file, "utf8")]),
  );
  const failures = [];

  for (const [source, content] of html) {
    const route = sourceRoute(path.join(distRoot, source));
    for (const link of links(content)) {
      if (!link || link.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(link)) {
        continue;
      }
      const resolved = new URL(link, `https://static.invalid${route}`);
      const target = targetFile(resolved.pathname, files);
      if (!target) {
        failures.push(`${source}: ${link} has no built target`);
        continue;
      }
      if (resolved.hash.length > 1 && target.endsWith(".html")) {
        const targetHtml = html.get(target);
        if (targetHtml && !fragmentExists(targetHtml, resolved.hash.slice(1))) {
          failures.push(`${source}: ${link} has no matching fragment`);
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Broken internal documentation links:\n${failures.join("\n")}`);
  }
  process.stderr.write(
    `Validated ${html.size} HTML pages and ${files.size} built files without HTTP requests.\n`,
  );
}

main();
