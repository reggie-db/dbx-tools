#!/usr/bin/env bun
/** Generate PEP 503 and Cargo sparse indexes from durable GitHub Release assets. */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function normalizePythonPackage(name) {
  return name.toLowerCase().replaceAll(/[._-]+/g, "-");
}

export function cargoIndexPath(name) {
  const crate = name.toLowerCase();
  if (crate.length === 1) return `1/${crate}`;
  if (crate.length === 2) return `2/${crate}`;
  if (crate.length === 3) return `3/${crate[0]}/${crate}`;
  return `${crate.slice(0, 2)}/${crate.slice(2, 4)}/${crate}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function releaseHeaders(token, binary = false) {
  return {
    accept: binary ? "application/octet-stream" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function responseBytes(fetchImpl, asset, token) {
  const response = await fetchImpl(asset.url, {
    headers: releaseHeaders(token, true),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Failed to download ${asset.name}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function releases(fetchImpl, repository, token) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      { headers: releaseHeaders(token) },
    );
    if (!response.ok) throw new Error(`Failed to list GitHub releases: ${response.status}`);
    const batch = await response.json();
    result.push(...batch.filter((release) => !release.draft));
    if (batch.length < 100) return result;
  }
}

function pageUrl(siteUrl, base, path) {
  const rootUrl = new URL(base.replace(/\/?$/, "/"), siteUrl);
  return new URL(path.replace(/^\//, ""), rootUrl).href;
}

function sortedVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

async function writePythonIndex(output, releaseList, fetchImpl, token) {
  const packages = new Map();
  for (const release of releaseList) {
    for (const asset of release.assets.filter((candidate) => candidate.name.endsWith(".whl"))) {
      const distribution = asset.name.split("-", 1)[0];
      if (!distribution) throw new Error(`Cannot determine Python distribution: ${asset.name}`);
      const name = normalizePythonPackage(distribution);
      const hash = asset.digest?.startsWith("sha256:")
        ? asset.digest.slice("sha256:".length)
        : createHash("sha256")
            .update(await responseBytes(fetchImpl, asset, token))
            .digest("hex");
      const entries = packages.get(name) ?? [];
      entries.push({
        filename: asset.name,
        url: `${asset.browser_download_url}#sha256=${hash}`,
      });
      packages.set(name, entries);
    }
  }

  const simple = join(output, "simple");
  await mkdir(simple, { recursive: true });
  const names = [...packages.keys()].sort();
  await writeFile(
    join(simple, "index.html"),
    `${names.map((name) => `<a href="${encodeURIComponent(name)}/">${escapeHtml(name)}</a>`).join("\n")}\n`,
  );
  for (const name of names) {
    const directory = join(simple, name);
    await mkdir(directory, { recursive: true });
    const entries = packages
      .get(name)
      .sort((left, right) => left.filename.localeCompare(right.filename));
    await writeFile(
      join(directory, "index.html"),
      `${entries.map((entry) => `<a href="${escapeHtml(entry.url)}">${escapeHtml(entry.filename)}</a>`).join("\n")}\n`,
    );
  }
}

async function writeCargoIndex(output, releaseList, fetchImpl, token, registryUrl) {
  const cargo = join(output, "cargo");
  const records = new Map();
  await mkdir(cargo, { recursive: true });
  await writeFile(
    join(cargo, "config.json"),
    `${JSON.stringify(
      {
        dl: `${registryUrl.replace(/^sparse\+/, "")}crates/{crate}/{crate}-{version}.crate`,
      },
      null,
      2,
    )}\n`,
  );

  for (const release of releaseList) {
    const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
    const manifestAsset = assets.get("cargo-index.json");
    if (!manifestAsset) continue;
    const manifest = JSON.parse(
      (await responseBytes(fetchImpl, manifestAsset, token)).toString("utf8"),
    );
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
      throw new Error(`Unsupported Cargo index manifest on ${release.tag_name}`);
    }
    for (const pkg of manifest.packages) {
      const asset = assets.get(pkg.asset);
      if (!asset) throw new Error(`${release.tag_name} is missing ${pkg.asset}`);
      const bytes = await responseBytes(fetchImpl, asset, token);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (checksum !== pkg.record.cksum) {
        throw new Error(`${pkg.asset} does not match its Cargo index checksum`);
      }
      const destination = join(cargo, "crates", pkg.record.name, pkg.asset);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      const versions = records.get(pkg.record.name) ?? new Map();
      const record = {
        ...pkg.record,
        deps: pkg.record.deps.map((dependency) => ({
          ...dependency,
          registry: dependency.registry === "self" ? null : dependency.registry,
        })),
      };
      const existing = versions.get(record.vers);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(`Conflicting Cargo index entries for ${record.name}@${record.vers}`);
      }
      versions.set(record.vers, record);
      records.set(record.name, versions);
    }
  }

  for (const [name, versions] of records) {
    const path = join(cargo, cargoIndexPath(name));
    await mkdir(dirname(path), { recursive: true });
    const source = [...versions.values()]
      .sort((left, right) => sortedVersions(left.vers, right.vers))
      .map((record) => JSON.stringify(record))
      .join("\n");
    await writeFile(path, `${source}\n`);
  }
}

/** Rebuild package indexes from every non-draft GitHub Release. */
export async function generatePackageIndexes(options) {
  const output = resolve(options.output);
  const releaseList = await releases(options.fetchImpl ?? fetch, options.repository, options.token);
  await rm(join(output, "simple"), { recursive: true, force: true });
  await rm(join(output, "cargo"), { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, ".nojekyll"), "");
  await writePythonIndex(output, releaseList, options.fetchImpl ?? fetch, options.token);
  const registryUrl = pageUrl(options.siteUrl, options.base, "cargo/");
  await writeCargoIndex(
    output,
    releaseList,
    options.fetchImpl ?? fetch,
    options.token,
    `sparse+${registryUrl}`,
  );
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  await generatePackageIndexes({
    repository,
    token: process.env.GH_TOKEN,
    siteUrl: process.env.DOCS_SITE_URL ?? "https://example.invalid",
    base: process.env.DOCS_BASE ?? "/",
    output: process.argv[2] ?? join(root, ".docs-build/site/public"),
  });
}
