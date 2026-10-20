/** Side-effect-free npm release identity and public registry helpers. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "@dbx-tools/core";
import { PUBLIC_NPM_REGISTRY_URL } from "./release-context.ts";

/** Registry and archive identity used to verify idempotent npm publication. */
export interface NpmReleaseIdentity {
  readonly access?: "public" | "restricted";
  readonly contentDigest?: string;
  readonly integrity?: string;
  readonly name: string;
  readonly repository?: unknown;
  readonly version: string;
}

/** npm package fields read directly from one release archive. */
export interface NpmArchiveManifest {
  readonly [key: string]: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly publishConfig?: { readonly access?: unknown };
  readonly repository?: unknown;
  readonly version?: string;
}

/** Verify that registry metadata represents the exact locally packed release. */
export function npmReleaseMatches(
  local: NpmReleaseIdentity,
  published: NpmReleaseIdentity | undefined,
): boolean {
  if (!published) return false;
  if (published.name !== local.name || published.version !== local.version) {
    throw new Error(`Published npm identity does not match ${local.name}@${local.version}`);
  }
  const localRepository = normalizedRepository(local.repository);
  const publishedRepository = normalizedRepository(published.repository);
  if (localRepository && publishedRepository && localRepository !== publishedRepository) {
    throw new Error(`Published npm repository does not match ${local.name}@${local.version}`);
  }
  if (
    local.contentDigest &&
    published.contentDigest &&
    local.contentDigest !== published.contentDigest
  ) {
    throw new Error(`Published npm content does not match ${local.name}@${local.version}`);
  }
  if (
    !(local.contentDigest && published.contentDigest) &&
    local.integrity &&
    published.integrity !== local.integrity
  ) {
    throw new Error(`Published npm integrity does not match ${local.name}@${local.version}`);
  }
  return true;
}

/** Read one published npm release identity, or `undefined` when it is absent. */
export async function publishedNpmRelease(
  name: string,
  version: string,
  registry = process.env.NPM_CONFIG_REGISTRY ?? PUBLIC_NPM_REGISTRY_URL,
  signal?: AbortSignal,
): Promise<NpmReleaseIdentity | undefined> {
  const response = await fetch(registryUrl(registry, name, version), {
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`npm registry lookup failed for ${name}@${version}: ${response.status}`);
  }
  const metadata = (await response.json()) as {
    dist?: { integrity?: string; tarball?: string };
    name?: string;
    repository?: unknown;
    version?: string;
  };
  if (!metadata.name || !metadata.version) {
    throw new Error(`npm registry returned an incomplete identity for ${name}@${version}`);
  }
  let contentDigest: string | undefined;
  if (metadata.dist?.tarball) {
    const archive = await fetch(metadata.dist.tarball, { signal });
    if (!archive.ok) {
      throw new Error(`npm tarball lookup failed for ${name}@${version}: ${archive.status}`);
    }
    const temp = mkdtempSync(join(tmpdir(), "projen-published-npm-"));
    const path = join(temp, "package.tgz");
    try {
      writeFileSync(path, Buffer.from(await archive.arrayBuffer()));
      contentDigest = npmArchiveContentDigest(path);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return {
    ...(contentDigest ? { contentDigest } : {}),
    integrity: metadata.dist?.integrity,
    name: metadata.name,
    repository: metadata.repository,
    version: metadata.version,
  };
}

/** Read one npm package manifest directly from its archive. */
export function readNpmArchiveManifest(path: string): NpmArchiveManifest {
  const result = spawnSync("tar", ["-xOf", path, "package/package.json"], {
    cwd: process.cwd(),
    stdout: "capture",
    stderr: "capture",
    stdin: "ignore",
    check: false,
  });
  if (result.exitCode !== 0 || !result.stdout) {
    throw new Error(`Cannot read npm package manifest from ${path}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as NpmArchiveManifest;
}

/** Read and hash the release identity embedded in an npm archive. */
export function readNpmArchiveIdentity(path: string): NpmReleaseIdentity {
  const manifest = readNpmArchiveManifest(path);
  if (!manifest.name || !manifest.version) {
    throw new Error(`npm archive has no package name or version: ${path}`);
  }
  const access = manifest.publishConfig?.access;
  if (access !== undefined && access !== "public" && access !== "restricted") {
    throw new Error(`npm archive has invalid publishConfig.access: ${String(access)}`);
  }
  return {
    ...(access ? { access } : {}),
    contentDigest: npmArchiveContentDigest(path),
    integrity: `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`,
    name: manifest.name,
    repository: manifest.repository,
    version: manifest.version,
  };
}

/** Hash paths, executable bits, symlink targets, and bytes while ignoring tar metadata. */
export function npmArchiveContentDigest(path: string): string {
  const temp = mkdtempSync(join(tmpdir(), "projen-npm-content-"));
  try {
    spawnSync("tar", ["-xzf", path, "-C", temp], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "capture",
      stdin: "ignore",
      check: true,
    });
    const hash = createHash("sha512");
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const entryPath = join(directory, entry.name);
        const name = relative(temp, entryPath).split("\\").join("/");
        const stat = lstatSync(entryPath);
        hash.update(`${entry.isDirectory() ? "D" : entry.isSymbolicLink() ? "L" : "F"}\0`);
        hash.update(`${name}\0${stat.mode & 0o111}\0`);
        if (entry.isDirectory()) visit(entryPath);
        else if (entry.isSymbolicLink()) hash.update(readlinkSync(entryPath));
        else hash.update(readFileSync(entryPath));
      }
    };
    visit(temp);
    return `sha512-${hash.digest("base64")}`;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function normalizedRepository(value: unknown): string | undefined {
  const url =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "url" in value
        ? String(value.url)
        : undefined;
  return url
    ?.replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function registryUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/$/, "")}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}
