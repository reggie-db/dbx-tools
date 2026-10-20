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
import { spawn, spawnSync } from "@dbx-tools/core";
import { combineAbortSignals, log, poll, toError } from "@dbx-tools/shared-core";
import {
  PUBLIC_NPM_REGISTRY_URL,
  PUBLICATION_REQUEST_TIMEOUT_SECONDS,
  PUBLICATION_WAIT_INTERVAL_SECONDS,
  PUBLICATION_WAIT_TIMEOUT_SECONDS,
} from "./release-context.ts";

const logger = log.logger("projen:npm-release");

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
  options: { readonly content?: boolean; readonly timeoutMs?: number } = {},
): Promise<NpmReleaseIdentity | undefined> {
  const requestSignal = combineAbortSignals(
    signal,
    AbortSignal.timeout(options.timeoutMs ?? PUBLICATION_REQUEST_TIMEOUT_SECONDS * 1_000),
  );
  const response = await fetch(registryUrl(registry, name, version), {
    headers: { accept: "application/json" },
    signal: requestSignal,
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
  if (options.content !== false && metadata.dist?.tarball) {
    const archive = await fetch(metadata.dist.tarball, { signal: requestSignal });
    if (archive.status === 404) return undefined;
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

/** Whether npm refused a retry because it already accepted this version for staging. */
export function isNpmStagedVersionConflict(error: unknown): boolean {
  const message = toError(error).message;
  return /409\b/.test(message) && /previously staged version/i.test(message);
}

/** Wait until the public registry serves the exact local npm archive. */
export async function waitForMatchingNpmRelease(
  local: NpmReleaseIdentity,
  registry?: string,
  options: {
    readonly intervalMs?: number;
    readonly requestTimeoutMs?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<void> {
  const selectedRegistry = registry ?? process.env.NPM_CONFIG_REGISTRY ?? PUBLIC_NPM_REGISTRY_URL;
  let lastError: Error | undefined;
  try {
    for await (const _available of poll(
      async ({ signal }) => {
        let published: NpmReleaseIdentity | undefined;
        try {
          published = await publishedNpmRelease(
            local.name,
            local.version,
            selectedRegistry,
            signal,
            { content: false, timeoutMs: options.requestTimeoutMs },
          );
        } catch (error) {
          lastError = toError(error);
          return false;
        }
        if (!published) return false;
        let complete: NpmReleaseIdentity | undefined;
        try {
          complete = await publishedNpmRelease(
            local.name,
            local.version,
            selectedRegistry,
            signal,
            { timeoutMs: options.requestTimeoutMs },
          );
        } catch (error) {
          lastError = toError(error);
          return false;
        }
        if (!complete) return false;
        lastError = undefined;
        return npmReleaseMatches(local, complete);
      },
      {
        intervalMs: options.intervalMs ?? PUBLICATION_WAIT_INTERVAL_SECONDS * 1_000,
        timeoutMs: options.timeoutMs ?? PUBLICATION_WAIT_TIMEOUT_SECONDS * 1_000,
        predicate: (available) => !available,
      },
    )) {
      void _available;
    }
  } catch (error) {
    throw new Error(`Staged npm version ${local.name}@${local.version} did not become available`, {
      cause: lastError ?? error,
    });
  }
}

/** Outcome of one idempotent npm archive publication. */
export type NpmPublishOutcome = "published" | "skipped" | "staged";

/** Publish one archive, or wait when npm has already staged that exact version. */
export async function publishNpmArchive(options: {
  readonly archive: string;
  readonly identity: NpmReleaseIdentity;
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly registry?: string;
  readonly timeoutMs?: number;
}): Promise<NpmPublishOutcome> {
  const { archive, identity } = options;
  if (!options.dryRun) {
    const published = await publishedNpmRelease(identity.name, identity.version, options.registry);
    if (npmReleaseMatches(identity, published)) return "skipped";
  }
  const result = await spawn(
    "npm",
    [
      "publish",
      archive,
      "--ignore-scripts",
      ...(identity.access ? ["--access", identity.access] : []),
      ...(options.registry ? ["--registry", options.registry] : []),
      ...(options.dryRun ? ["--dry-run"] : []),
    ],
    {
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "capture",
      check: false,
    },
  );
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  if (result.exitCode === 0) return "published";
  const error = new Error(
    `npm publish failed (exit ${result.exitCode})${result.stderr ? `: ${result.stderr}` : ""}`,
  );
  if (options.dryRun) throw error;
  const published = await publishedNpmRelease(identity.name, identity.version, options.registry);
  if (npmReleaseMatches(identity, published)) return "skipped";
  if (!isNpmStagedVersionConflict(error)) throw error;
  logger.info(`waiting for staged ${identity.name}@${identity.version}`);
  await waitForMatchingNpmRelease(identity, options.registry, {
    intervalMs: options.intervalMs,
    requestTimeoutMs: options.requestTimeoutMs,
    timeoutMs: options.timeoutMs,
  });
  return "staged";
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
