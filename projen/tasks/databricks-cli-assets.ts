#!/usr/bin/env -S bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import * as projectUtils from "@dbx-tools/core/project-utils";

import { makeReadonly, makeWritable } from "../src/generated.ts";

const MINIMUM_VERSION = "0.296.0";
const REPOSITORY = "databricks/cli";
const PLATFORM_ASSETS = {
  "darwin-arm64": "darwin_arm64",
  "darwin-x64": "darwin_amd64",
  "linux-arm64": "linux_arm64",
  "linux-x64": "linux_amd64",
  "win32-arm64": "windows_arm64",
  "win32-x64": "windows_amd64",
} as const;

interface GitHubAsset {
  readonly browser_download_url: string;
  readonly digest?: string;
  readonly name: string;
}

interface GitHubRelease {
  readonly assets: GitHubAsset[];
  readonly published_at: string;
  readonly tag_name: string;
}

interface CliAsset {
  readonly sha256: string;
  readonly url: string;
}

interface CliAssetManifest {
  readonly schemaVersion: 1;
  readonly dbxToolsVersion: string;
  readonly minimumVersion: string;
  readonly version: string;
  readonly publishedAt: string;
  readonly assets: Record<keyof typeof PLATFORM_ASSETS, CliAsset>;
}

function validManifest(value: unknown, dbxToolsVersion: string): value is CliAssetManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<CliAssetManifest>;
  return (
    manifest.schemaVersion === 1 &&
    manifest.dbxToolsVersion === dbxToolsVersion &&
    manifest.minimumVersion === MINIMUM_VERSION &&
    typeof manifest.version === "string" &&
    typeof manifest.publishedAt === "string" &&
    Boolean(manifest.assets) &&
    Object.keys(PLATFORM_ASSETS).every((key) => {
      const asset = manifest.assets?.[key as keyof typeof PLATFORM_ASSETS];
      return (
        typeof asset?.url === "string" &&
        typeof asset.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(asset.sha256)
      );
    })
  );
}

async function latestManifest(dbxToolsVersion: string): Promise<CliAssetManifest> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `dbx-tools/${dbxToolsVersion}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Could not resolve the latest Databricks CLI release (${response.status})`);
  }
  const release = (await response.json()) as GitHubRelease;
  const version = release.tag_name.replace(/^v/, "");
  const assets = Object.fromEntries(
    Object.entries(PLATFORM_ASSETS).map(([platform, suffix]) => {
      const name = `databricks_cli_${version}_${suffix}.tar.gz`;
      const asset = release.assets.find((candidate) => candidate.name === name);
      const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
      if (!asset || !sha256)
        throw new Error(`Release ${release.tag_name} has no digest for ${name}`);
      return [platform, { url: asset.browser_download_url, sha256 }];
    }),
  ) as CliAssetManifest["assets"];
  return {
    schemaVersion: 1,
    dbxToolsVersion,
    minimumVersion: MINIMUM_VERSION,
    version,
    publishedAt: release.published_at,
    assets,
  };
}

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    root: { type: "string" },
  },
  strict: true,
});
const root = resolve(values.root ?? projectUtils.root() ?? process.cwd());
const output = join(root, "packages/js/node/auth/src/generated/databricks-cli-assets.json");
const dbxToolsVersion = readFileSync(join(root, "VERSION"), "utf8").trim();
let current: unknown;
if (existsSync(output)) {
  try {
    current = JSON.parse(readFileSync(output, "utf8"));
  } catch {
    current = undefined;
  }
}
if (validManifest(current, dbxToolsVersion)) {
  console.log(`verified ${output.slice(root.length + 1)}`);
} else if (values.check) {
  throw new Error("Databricks CLI asset manifest is missing or stale");
} else {
  const manifest = await latestManifest(dbxToolsVersion);
  mkdirSync(dirname(output), { recursive: true });
  makeWritable(output);
  writeFileSync(output, `${JSON.stringify(manifest, undefined, 2)}\n`);
  makeReadonly(output);
  console.log(`generated ${output.slice(root.length + 1)}`);
}
