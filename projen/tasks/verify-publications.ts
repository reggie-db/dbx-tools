#!/usr/bin/env -S bun
/** Wait for one release batch to become available from public package registries. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { log, poll, mapConcurrent, toError } from "@dbx-tools/shared-core";
import { z } from "zod";
import { runTaskMain, taskCommand, taskOptions } from "./cli.ts";
import {
  npmReleaseMatches,
  publishedNpmRelease,
  readNpmArchiveIdentity,
} from "../src/npm-release.ts";
import {
  PUBLIC_NPM_REGISTRY_URL,
  PUBLIC_PYPI_REGISTRY_URL,
  PUBLICATION_WAIT_INTERVAL_SECONDS,
  PUBLICATION_WAIT_TIMEOUT_SECONDS,
} from "../src/release-context.ts";

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_INTERVAL_SECONDS = PUBLICATION_WAIT_INTERVAL_SECONDS;
const DEFAULT_TIMEOUT_SECONDS = PUBLICATION_WAIT_TIMEOUT_SECONDS;
const logger = log.logger("projen:verify-publications");

const PypiReleaseSchema = z
  .object({
    urls: z
      .array(
        z
          .object({
            filename: z.string().describe("Published distribution filename"),
            digests: z
              .object({
                sha256: z.string().describe("Published distribution SHA-256 digest"),
              })
              .describe("Published distribution digests"),
          })
          .describe("One published Python distribution"),
      )
      .describe("Published Python distributions"),
  })
  .describe("PyPI release metadata");

interface PypiReleaseIdentity {
  readonly files: ReadonlyMap<string, string>;
  readonly name: string;
  readonly version: string;
}

/** One public artifact group checked during the shared availability barrier. */
export interface PublicationProbe {
  /** Human-readable package identity used in progress and timeout messages. */
  readonly label: string;
  /** Return true only when the exact expected public artifact is available. */
  available(signal: AbortSignal): boolean | PromiseLike<boolean>;
}

/** Timing and concurrency controls for the shared publication barrier. */
export interface PublicationWaitOptions {
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/** Poll every unresolved publication concurrently and stop after one shared timeout. */
export async function waitForPublications(
  probes: readonly PublicationProbe[],
  options: PublicationWaitOptions = {},
): Promise<void> {
  if (probes.length === 0) throw new Error("No public publications were provided");
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const errors = new Map<string, Error>();
  let pending = [...probes];
  let previousCount: number | undefined;
  try {
    for await (const unavailable of poll<PublicationProbe[]>(
      async ({ signal }) => {
        const results = await mapConcurrent(
          pending,
          async (probe) => {
            try {
              const available = await probe.available(signal);
              if (available) errors.delete(probe.label);
              return { available, probe };
            } catch (error) {
              errors.set(probe.label, toError(error));
              return { available: false, probe };
            }
          },
          { concurrency },
        );
        return results.filter(({ available }) => !available).map(({ probe }) => probe);
      },
      {
        intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_SECONDS * 1_000,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1_000,
        predicate: (unavailable) => unavailable.length > 0,
      },
    )) {
      pending = unavailable;
      if (pending.length > 0 && pending.length !== previousCount) {
        logger.info(
          `waiting for ${pending.length} public publication${pending.length === 1 ? "" : "s"}`,
        );
      }
      previousCount = pending.length;
    }
  } catch (error) {
    if (pending.length === 0) throw error;
    const details = pending
      .map((probe) => {
        const failure = errors.get(probe.label);
        return failure ? `${probe.label}: ${failure.message}` : probe.label;
      })
      .join("\n");
    throw new Error(`Publications did not become available:\n${details}`, { cause: error });
  }
  logger.info(`verified ${probes.length} public publication${probes.length === 1 ? "" : "s"}`);
}

function npmPublicationProbes(directory: string, version: string): PublicationProbe[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".tgz"))
    .sort()
    .map((file) => {
      const local = readNpmArchiveIdentity(join(directory, file));
      if (local.version !== version) {
        throw new Error(`${local.name} archive carries ${local.version}, expected ${version}`);
      }
      return {
        label: `${local.name}@${local.version}`,
        available: async (signal: AbortSignal) =>
          npmReleaseMatches(
            local,
            await publishedNpmRelease(local.name, local.version, PUBLIC_NPM_REGISTRY_URL, signal),
          ),
      };
    });
}

function distributionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return distributionFiles(path);
    return entry.name.endsWith(".whl") || entry.name.endsWith(".tar.gz") ? [path] : [];
  });
}

function pythonDistributionName(file: string, version: string): string {
  const name = basename(file);
  const sourceSuffix = `-${version}.tar.gz`;
  if (name.endsWith(sourceSuffix)) {
    return name.slice(0, -sourceSuffix.length).replaceAll("_", "-").toLowerCase();
  }
  if (name.endsWith(".whl")) {
    const marker = `-${version}-`;
    const markerIndex = name.lastIndexOf(marker);
    if (markerIndex > 0) {
      return name.slice(0, markerIndex).replaceAll("_", "-").toLowerCase();
    }
  }
  throw new Error(`Python distribution ${name} does not carry release version ${version}`);
}

function pypiReleaseIdentities(directory: string, version: string): PypiReleaseIdentity[] {
  const releases = new Map<string, Map<string, string>>();
  for (const path of distributionFiles(directory)) {
    const name = pythonDistributionName(path, version);
    const files = releases.get(name) ?? new Map<string, string>();
    const filename = basename(path);
    files.set(filename, createHash("sha256").update(readFileSync(path)).digest("hex"));
    releases.set(name, files);
  }
  return [...releases]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, files]) => ({ files, name, version }));
}

function pypiPublicationProbes(directory: string, version: string): PublicationProbe[] {
  return pypiReleaseIdentities(directory, version).map((local) => ({
    label: `${local.name}==${local.version}`,
    available: async (signal: AbortSignal) => {
      const response = await fetch(
        `${PUBLIC_PYPI_REGISTRY_URL}/${encodeURIComponent(local.name)}/${encodeURIComponent(local.version)}/json`,
        {
          headers: { accept: "application/json" },
          signal,
        },
      );
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new Error(
          `PyPI lookup failed for ${local.name}==${local.version}: ${response.status}`,
        );
      }
      const published = PypiReleaseSchema.parse(await response.json());
      const publishedFiles = new Map(
        published.urls.map(({ filename, digests }) => [filename, digests.sha256]),
      );
      for (const [filename, digest] of local.files) {
        const publishedDigest = publishedFiles.get(filename);
        if (!publishedDigest) return false;
        if (publishedDigest !== digest) {
          throw new Error(
            `PyPI content does not match ${local.name}==${local.version} ${filename}`,
          );
        }
      }
      return true;
    },
  }));
}

export const VerifyPublicationsOptionsSchema = z
  .object({
    version: z.string().trim().min(1).describe("Expected public release version"),
    npmDirectory: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Directory containing released npm archives"),
    pypiDirectory: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Directory containing released Python distributions"),
    concurrency: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_CONCURRENCY)
      .describe("Maximum concurrent public registry checks"),
    intervalSeconds: z.coerce
      .number()
      .positive()
      .default(DEFAULT_INTERVAL_SECONDS)
      .describe("Delay between shared publication checks"),
    timeoutSeconds: z.coerce
      .number()
      .positive()
      .default(DEFAULT_TIMEOUT_SECONDS)
      .describe("Maximum time to wait for the complete publication batch"),
  })
  .refine((options) => options.npmDirectory || options.pypiDirectory, {
    message: "At least one publication directory is required",
  })
  .describe("Options for the public package availability barrier");

/** Parse expected release artifacts and wait for their public registry records. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = await taskOptions(
    taskCommand(
      import.meta.url,
      "Wait for released packages to become publicly available",
      VerifyPublicationsOptionsSchema,
    ),
    VerifyPublicationsOptionsSchema,
    args,
  );
  const probes = [
    ...(options.npmDirectory
      ? npmPublicationProbes(resolve(options.npmDirectory), options.version)
      : []),
    ...(options.pypiDirectory
      ? pypiPublicationProbes(resolve(options.pypiDirectory), options.version)
      : []),
  ];
  await waitForPublications(probes, {
    concurrency: options.concurrency,
    intervalMs: options.intervalSeconds * 1_000,
    timeoutMs: options.timeoutSeconds * 1_000,
  });
}

await runTaskMain(import.meta, main);
