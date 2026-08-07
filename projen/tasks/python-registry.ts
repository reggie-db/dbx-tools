import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { exec } from "@dbx-tools/core";
import { net } from "@dbx-tools/shared-core";

export interface LocalPythonRegistry {
  readonly indexUrl: string;
  readonly publishUrl: string;
}

/** Read the default index URL from uv's TOML configuration. */
export function parseUvDefaultIndex(source: string): string | undefined {
  const blocks = source.split(/(?=^\[\[index\]\]\s*$)/m);
  for (const block of blocks) {
    if (!/^\[\[index\]\]\s*$/m.test(block) || !/^\s*default\s*=\s*true\s*$/m.test(block)) {
      continue;
    }
    const url = /^\s*url\s*=\s*["']([^"']+)["']\s*$/m.exec(block)?.[1];
    if (url) return url;
  }
  return undefined;
}

/**
 * Read EVERY index URL from uv's TOML config — the default (primary) index
 * first, then any extra `[[index]]` entries in file order. uv's `[[index]]`
 * table with `default = true` is the primary index; every other `[[index]]`
 * is an extra index also consulted at resolve time, so a local devpi added as
 * a non-default block is discoverable here.
 */
export function parseUvIndexes(source: string): string[] {
  const blocks = source.split(/(?=^\[\[index\]\]\s*$)/m);
  let primary: string | undefined;
  const extras: string[] = [];
  for (const block of blocks) {
    if (!/^\[\[index\]\]\s*$/m.test(block)) continue;
    const url = /^\s*url\s*=\s*["']([^"']+)["']\s*$/m.exec(block)?.[1];
    if (!url) continue;
    if (/^\s*default\s*=\s*true\s*$/m.test(block)) primary = url;
    else extras.push(url);
  }
  return primary ? [primary, ...extras] : extras;
}

/**
 * Read every `[[index]]` block's `url` -> `publish-url` mapping from uv's TOML
 * config. uv lets an index declare an explicit upload endpoint via `publish-url`
 * (the writable index URL, distinct from the `+simple` read URL); this is the
 * global setting that names the local deploy target, so auto-detection prefers
 * it over deriving the publish URL from the `+simple` URL shape.
 */
export function parseUvPublishUrls(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const blocks = source.split(/(?=^\[\[index\]\]\s*$)/m);
  for (const block of blocks) {
    if (!/^\[\[index\]\]\s*$/m.test(block)) continue;
    const url = /^\s*url\s*=\s*["']([^"']+)["']\s*$/m.exec(block)?.[1];
    const publishUrl = /^\s*publish-url\s*=\s*["']([^"']+)["']\s*$/m.exec(block)?.[1];
    if (url && publishUrl) map.set(url, publishUrl);
  }
  return map;
}

/**
 * The explicit `publish-url` configured (in the global uv config or
 * `UV_PUBLISH_URL`) for a given `+simple` index URL, or `undefined` when none is
 * set. Lets auto-detection use the deploy endpoint the user declared globally
 * rather than inferring it from the index URL.
 */
export function configuredPublishUrl(
  indexUrl: string,
  uvConfigPath: string = process.env.UV_CONFIG_FILE ?? resolve(homedir(), ".config/uv/uv.toml"),
): string | undefined {
  const fromEnv = process.env.UV_PUBLISH_URL?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(uvConfigPath)) return undefined;
  return parseUvPublishUrls(readFileSync(uvConfigPath, "utf8")).get(indexUrl);
}

/**
 * Convert a devpi Simple API URL into a local publish target.
 *
 * The publish URL is taken from the GLOBAL uv config first — an explicit
 * `publish-url` on the matching `[[index]]` (or `UV_PUBLISH_URL`), i.e. the
 * deploy endpoint the user declared — and only DERIVED from the `+simple` URL
 * shape when no such setting exists. Returns `undefined` for a non-loopback
 * host or a URL that is neither a `+simple` index nor has a configured
 * `publish-url`.
 */
export function devpiRegistry(index: string): LocalPythonRegistry | undefined {
  let url: URL;
  try {
    url = new URL(index);
  } catch {
    return undefined;
  }
  if (!net.isLoopbackHost(url)) return undefined;

  // A globally-configured publish-url wins: it names the deploy target directly,
  // so we honor it even if the index URL isn't the conventional `+simple` shape.
  const configured = configuredPublishUrl(url.href);
  if (configured) {
    return {
      indexUrl: url.href,
      publishUrl: configured.endsWith("/") ? configured : `${configured}/`,
    };
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/+simple")) return undefined;
  url.pathname = `${path.slice(0, -"/+simple".length)}/`;
  url.search = "";
  url.hash = "";
  return {
    indexUrl: new URL("+simple/", url).href,
    publishUrl: url.href,
  };
}

/** Split a whitespace-separated index list (the pip/uv env-var form). */
function splitIndexList(value: string | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

/** Read a `pip config get <key>`, treating pip's literal "undefined" as unset. */
function pipConfig(key: string): string | undefined {
  const res = exec.spawnSync("python", ["-m", "pip", "config", "get", key], {
    cwd: process.cwd(),
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: false,
  });
  const out = res.stdout?.trim();
  return out && out !== "undefined" ? out : undefined;
}

/**
 * Every Python package index in effect — the primary index FIRST, then extra
 * indexes — deduplicated, across uv (preferred, because Python builds use uv)
 * and pip. Both the primary `index-url` and every `extra-index-url` are read so
 * a local devpi configured as an *extra* index (leaving the corp proxy as the
 * primary) is still detected.
 */
export function activePythonIndexes(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string | undefined): void => {
    const url = value?.trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };

  // uv: env vars first (primary, then extras), then uv.toml's index blocks.
  add(process.env.UV_DEFAULT_INDEX);
  add(process.env.UV_INDEX_URL);
  for (const url of splitIndexList(process.env.UV_INDEX)) add(url);
  for (const url of splitIndexList(process.env.UV_EXTRA_INDEX_URL)) add(url);
  const uvConfig = process.env.UV_CONFIG_FILE ?? resolve(homedir(), ".config/uv/uv.toml");
  if (existsSync(uvConfig)) {
    for (const url of parseUvIndexes(readFileSync(uvConfig, "utf8"))) add(url);
  }

  // pip: env vars (primary + extras), then `pip config` (index-url + extra-index-url).
  add(process.env.PIP_INDEX_URL);
  for (const url of splitIndexList(process.env.PIP_EXTRA_INDEX_URL)) add(url);
  add(pipConfig("global.index-url"));
  for (const url of splitIndexList(pipConfig("global.extra-index-url"))) add(url);

  return out;
}

/** The primary (first) active Python index, or `undefined` when none is set. */
export function activePythonIndex(): string | undefined {
  return activePythonIndexes()[0];
}

/**
 * Resolve `auto`, `false`, or an explicit devpi index/publish URL.
 *
 * - `false` (or empty): skip local publishing.
 * - a URL: publish there (derive the writable index from a `+simple` URL, else
 *   treat the value itself as the writable index).
 * - `auto`: scan every active index — primary `index-url` AND every
 *   `extra-index-url`, across uv and pip — and publish to the FIRST that is a
 *   loopback devpi `+simple` index. This is what lets the corp proxy stay the
 *   primary index while a local devpi added as an extra is the publish target.
 *
 * `indexes` accepts an array (the normal case) or a single string (kept for the
 * existing single-index callers/tests); it defaults to {@link activePythonIndexes}.
 */
export function resolveLocalPypi(
  value: string,
  indexes: readonly string[] | string | undefined = activePythonIndexes(),
): LocalPythonRegistry | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "false") return undefined;
  if (trimmed.toLowerCase() === "auto") {
    const list = typeof indexes === "string" ? [indexes] : (indexes ?? []);
    for (const index of list) {
      const registry = devpiRegistry(index);
      if (registry) return registry;
    }
    return undefined;
  }

  const derived = devpiRegistry(trimmed);
  if (derived) return derived;
  const publishUrl = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  return {
    publishUrl,
    indexUrl: new URL("+simple/", publishUrl).href,
  };
}
