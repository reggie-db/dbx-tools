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

/** Convert a devpi Simple API URL into its writable index URL. */
export function devpiRegistry(index: string): LocalPythonRegistry | undefined {
  let url: URL;
  try {
    url = new URL(index);
  } catch {
    return undefined;
  }
  if (!net.isLoopbackHost(url)) return undefined;

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

/** The active Python package index, preferring uv because Python builds use uv. */
export function activePythonIndex(): string | undefined {
  for (const value of [process.env.UV_DEFAULT_INDEX, process.env.UV_INDEX_URL]) {
    if (value?.trim()) return value.trim();
  }

  const uvConfig = process.env.UV_CONFIG_FILE ?? resolve(homedir(), ".config/uv/uv.toml");
  if (existsSync(uvConfig)) {
    const index = parseUvDefaultIndex(readFileSync(uvConfig, "utf8"));
    if (index) return index;
  }

  if (process.env.PIP_INDEX_URL?.trim()) return process.env.PIP_INDEX_URL.trim();
  const pip = exec.spawnSync("python", ["-m", "pip", "config", "get", "global.index-url"], {
    cwd: process.cwd(),
    stdout: "capture",
    stderr: "ignore",
    stdin: "ignore",
    check: false,
  });
  return pip.stdout?.trim() || undefined;
}

/** Resolve `auto`, `false`, or an explicit devpi index/publish URL. */
export function resolveLocalPypi(
  value: string,
  activeIndex: string | undefined = activePythonIndex(),
): LocalPythonRegistry | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "false") return undefined;
  if (trimmed.toLowerCase() === "auto") {
    return activeIndex ? devpiRegistry(activeIndex) : undefined;
  }

  const derived = devpiRegistry(trimmed);
  if (derived) return derived;
  const publishUrl = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  return {
    publishUrl,
    indexUrl: new URL("+simple/", publishUrl).href,
  };
}
