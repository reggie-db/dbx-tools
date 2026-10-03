#!/usr/bin/env -S bun
/** Create, verify, and select immutable release-candidate assets. */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type ReleaseArtifactKind = "binary" | "npm" | "pypi";
export type ReleaseArtifactRole = "facade" | "native" | "workspace";

export interface ReleaseArtifactInput {
  readonly kind: ReleaseArtifactKind;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly path: string;
  readonly role?: ReleaseArtifactRole;
}

export interface ReleaseArtifact {
  readonly kind: ReleaseArtifactKind;
  readonly name: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly role?: ReleaseArtifactRole;
  readonly sha256: string;
  readonly size: number;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly tag: string;
  readonly version: string;
  readonly gitSha: string;
  readonly artifacts: readonly ReleaseArtifact[];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Copy release artifacts into one upload directory and write its trust manifest. */
export function writeReleaseManifest(options: {
  readonly artifacts: readonly ReleaseArtifactInput[];
  readonly directory: string;
  readonly gitSha: string;
  readonly tag: string;
  readonly version: string;
}): ReleaseManifest {
  const directory = resolve(options.directory);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const names = new Set<string>();
  const artifacts = options.artifacts
    .map((artifact): ReleaseArtifact => {
      const source = resolve(artifact.path);
      if (!existsSync(source)) throw new Error(`Missing release artifact: ${source}`);
      const name = basename(source);
      if (names.has(name)) throw new Error(`Duplicate release artifact name: ${name}`);
      names.add(name);
      copyFileSync(source, join(directory, name));
      return {
        kind: artifact.kind,
        name,
        ...(artifact.packageName ? { packageName: artifact.packageName } : {}),
        ...(artifact.packageVersion ? { packageVersion: artifact.packageVersion } : {}),
        ...(artifact.role ? { role: artifact.role } : {}),
        sha256: sha256(source),
        size: statSync(source).size,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    tag: options.tag,
    version: options.version,
    gitSha: options.gitSha,
    artifacts,
  };
  writeFileSync(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`,
  );
  return manifest;
}

function readManifest(directory: string): ReleaseManifest {
  const value = JSON.parse(
    readFileSync(join(directory, "release-manifest.json"), "utf8"),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unsupported release manifest");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.tag !== "string" ||
    typeof record.version !== "string" ||
    typeof record.gitSha !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.gitSha) ||
    !Array.isArray(record.artifacts)
  ) {
    throw new Error("Unsupported release manifest");
  }
  const names = new Set<string>();
  const artifacts = record.artifacts.map((value): ReleaseArtifact => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid release artifact");
    }
    const artifact = value as Record<string, unknown>;
    if (
      !["binary", "npm", "pypi"].includes(String(artifact.kind)) ||
      typeof artifact.name !== "string" ||
      basename(artifact.name) !== artifact.name ||
      artifact.name === "." ||
      artifact.name === ".." ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      Number(artifact.size) < 0
    ) {
      throw new Error("Invalid release artifact");
    }
    if (names.has(artifact.name)) {
      throw new Error(`Duplicate release artifact name: ${artifact.name}`);
    }
    names.add(artifact.name);
    const kind = artifact.kind as ReleaseArtifactKind;
    const packageName = artifact.packageName;
    const packageVersion = artifact.packageVersion;
    const role = artifact.role;
    if (
      (packageName !== undefined && typeof packageName !== "string") ||
      (packageVersion !== undefined && typeof packageVersion !== "string") ||
      (role !== undefined && !["facade", "native", "workspace"].includes(String(role))) ||
      (kind !== "binary" && (!packageName || !packageVersion))
    ) {
      throw new Error(`Invalid release artifact metadata: ${artifact.name}`);
    }
    return {
      kind,
      name: artifact.name,
      ...(packageName ? { packageName } : {}),
      ...(packageVersion ? { packageVersion } : {}),
      ...(role ? { role: role as ReleaseArtifactRole } : {}),
      sha256: artifact.sha256,
      size: Number(artifact.size),
    };
  });
  return {
    schemaVersion: 1,
    tag: record.tag,
    version: record.version,
    gitSha: record.gitSha,
    artifacts,
  };
}

/** Verify a release bundle and optionally extract one registry/package subset. */
export function verifyReleaseManifest(options: {
  readonly directory: string;
  readonly gitSha: string;
  readonly kind?: ReleaseArtifactKind;
  readonly output?: string;
  readonly packageName?: string;
  readonly tag: string;
  readonly version: string;
}): readonly ReleaseArtifact[] {
  const directory = resolve(options.directory);
  const manifest = readManifest(directory);
  if (manifest.tag !== options.tag) {
    throw new Error(`Release manifest tag ${manifest.tag} does not match ${options.tag}`);
  }
  if (manifest.version !== options.version) {
    throw new Error(
      `Release manifest version ${manifest.version} does not match ${options.version}`,
    );
  }
  if (manifest.gitSha !== options.gitSha) {
    throw new Error(`Release manifest SHA ${manifest.gitSha} does not match ${options.gitSha}`);
  }
  for (const artifact of manifest.artifacts) {
    if (artifact.kind !== "binary" && artifact.packageVersion !== options.version) {
      throw new Error(
        `Release artifact ${artifact.name} carries ${String(artifact.packageVersion)}, expected ${options.version}`,
      );
    }
  }
  const expectedChecksums = `${manifest.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n")}\n`;
  const checksums = readFileSync(join(directory, "SHA256SUMS"), "utf8");
  if (checksums !== expectedChecksums) throw new Error("SHA256SUMS does not match the manifest");
  const selected = manifest.artifacts.filter(
    (artifact) =>
      (!options.kind || artifact.kind === options.kind) &&
      (!options.packageName || artifact.packageName === options.packageName),
  );
  if ((options.kind || options.packageName) && selected.length === 0) {
    throw new Error("Release manifest selection matched no artifacts");
  }
  if (!options.kind && !options.packageName) {
    const expected = new Set([
      "release-manifest.json",
      "SHA256SUMS",
      ...manifest.artifacts.map((artifact) => artifact.name),
    ]);
    const present = readdirSync(directory).filter((name) => !name.startsWith("."));
    const unexpected = present.filter((name) => !expected.has(name));
    if (unexpected.length > 0) {
      throw new Error(`Release contains unmanifested assets: ${unexpected.sort().join(", ")}`);
    }
  }
  const output = options.output ? resolve(options.output) : undefined;
  if (output) {
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
  }
  for (const artifact of selected) {
    const source = join(directory, artifact.name);
    if (!existsSync(source)) throw new Error(`Missing release asset: ${artifact.name}`);
    if (statSync(source).size !== artifact.size) {
      throw new Error(`Release asset size does not match: ${artifact.name}`);
    }
    if (sha256(source) !== artifact.sha256) {
      throw new Error(`Release asset checksum does not match: ${artifact.name}`);
    }
    if (output) copyFileSync(source, join(output, artifact.name));
  }
  return selected;
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      kind: { type: "string" },
      output: { type: "string" },
      package: { type: "string" },
      sha: { type: "string" },
      tag: { type: "string" },
      version: { type: "string" },
    },
  });
  if (positionals[0] !== "verify") throw new Error("Expected verify command");
  if (!values.directory || !values.sha || !values.tag || !values.version) {
    throw new Error("verify requires --directory, --sha, --tag, and --version");
  }
  if (values.kind && !["binary", "npm", "pypi"].includes(values.kind)) {
    throw new Error(`Unknown release artifact kind: ${values.kind}`);
  }
  verifyReleaseManifest({
    directory: values.directory,
    gitSha: values.sha,
    ...(values.kind ? { kind: values.kind as ReleaseArtifactKind } : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.package ? { packageName: values.package } : {}),
    tag: values.tag,
    version: values.version,
  });
}
