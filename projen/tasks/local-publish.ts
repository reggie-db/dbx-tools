/** Local registry preflight shared by release preparation. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, project } from "@dbx-tools/core";
import { log, net } from "@dbx-tools/shared-core";
import { readDbxToolsConfig } from "../src/packages.ts";
import { activePythonIndexes, resolveLocalPypi } from "./python-registry.ts";

const logger = log.logger("projen:local-publish");

/** Options for publishing one release candidate to configured loopback registries. */
export interface LocalPublishOptions {
  readonly root: string;
  readonly version: string;
  readonly localRegistry: string;
  readonly localPypi: string;
  readonly pythonRoot: string;
  readonly localCargo: boolean;
}

function resolveLocalRegistry(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "false") return undefined;
  if (trimmed.toLowerCase() === "auto") {
    const registry = project.npmRegistry();
    return registry && net.isLoopbackHost(registry) ? registry.href : undefined;
  }
  return trimmed;
}

function localCargoRegistry(): string | undefined {
  if (process.env.LOCAL_CARGO_REGISTRY) return process.env.LOCAL_CARGO_REGISTRY;
  const config = join(homedir(), ".cargo", "config.toml");
  if (!existsSync(config)) return undefined;
  const source = readFileSync(config, "utf8");
  const sections = [
    ...source.matchAll(/^\[registries\.([^\]]+)\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm),
  ];
  for (const section of sections) {
    const index = section[2]?.match(/^\s*index\s*=\s*["']([^"']+)["']/m)?.[1];
    if (index && net.isLoopbackHost(index.replace(/^sparse\+/, ""))) return section[1];
  }
  return undefined;
}

/** Publish the exact release candidate to local npm, PyPI, and Cargo mirrors. */
export async function publishLocalRelease(options: LocalPublishOptions): Promise<void> {
  const localRegistry = resolveLocalRegistry(options.localRegistry);
  const activeIndexes = activePythonIndexes();
  const localPypi = resolveLocalPypi(options.localPypi, activeIndexes);
  const pythonRoot = resolve(options.root, options.pythonRoot);
  const localPublishes: Promise<unknown>[] = [];

  if (
    options.localPypi.toLowerCase() === "auto" &&
    activeIndexes.some((index) => net.isLoopbackHost(index)) &&
    !localPypi
  ) {
    logger.info(
      `skipped local Python publish: no active index (${activeIndexes.join(", ")}) is a devpi +simple index`,
    );
  }

  if (localRegistry) {
    const publishScript = fileURLToPath(new URL("./publish.ts", import.meta.url));
    logger.info(`publishing ${options.version} to local registry ${localRegistry}`);
    localPublishes.push(
      exec
        .spawn(process.execPath, [publishScript, options.version, "--registry", localRegistry], {
          cwd: options.root,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
        })
        .then(() => logger.success(`published ${options.version} to ${localRegistry}`)),
    );
  }

  if (localPypi && existsSync(pythonRoot)) {
    const publishPythonScript = fileURLToPath(new URL("./publish-python.ts", import.meta.url));
    logger.info(`publishing Python ${options.version} to local devpi ${localPypi.publishUrl}`);
    localPublishes.push(
      exec
        .spawn(
          process.execPath,
          [
            publishPythonScript,
            options.version,
            "--root",
            pythonRoot,
            "--index-url",
            localPypi.indexUrl,
            "--publish-url",
            localPypi.publishUrl,
          ],
          {
            cwd: options.root,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "ignore",
            check: true,
          },
        )
        .then(() =>
          logger.success(`published Python ${options.version} to ${localPypi.publishUrl}`),
        ),
    );
  }

  await Promise.all(localPublishes);
  if (localRegistry || localPypi) {
    const publishUniFFIScript = fileURLToPath(
      new URL("./publish-uniffi-local.ts", import.meta.url),
    );
    await exec.spawn(
      process.execPath,
      [
        publishUniFFIScript,
        "--version",
        options.version,
        ...(localRegistry ? ["--registry", localRegistry] : []),
        ...(localPypi ? ["--pypi-publish-url", localPypi.publishUrl] : []),
      ],
      {
        cwd: options.root,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
        check: true,
      },
    );
    logger.success(`published host-native bindings for ${options.version}`);
  }

  const rust = readDbxToolsConfig(options.root)?.rust;
  const hasRustCrates = Boolean(
    rust &&
    typeof rust === "object" &&
    !Array.isArray(rust) &&
    Array.isArray((rust as { crates?: unknown }).crates) &&
    (rust as { crates: unknown[] }).crates.length > 0,
  );
  if (options.localCargo && hasRustCrates) {
    const cargoRegistry = localCargoRegistry();
    if (cargoRegistry) {
      const publishUniFFIScript = fileURLToPath(
        new URL("./publish-uniffi-local.ts", import.meta.url),
      );
      await exec.spawn(
        process.execPath,
        [publishUniFFIScript, "--version", options.version, "--cargo-registry", cargoRegistry],
        {
          cwd: options.root,
          stdout: "inherit",
          stderr: "inherit",
          stdin: "ignore",
          check: true,
        },
      );
      logger.success(`published Rust ${options.version} to ${cargoRegistry}`);
    }
  }
}
