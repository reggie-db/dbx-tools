#!/usr/bin/env -S bun
/** Build and optionally upload every native release target from macOS. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { json, log } from "@dbx-tools/shared-core";
import { Command } from "commander";
import { releaseBinaryAssetName } from "../src/_release-platform.ts";
import type {
  RustReleaseConfiguration,
  RustReleaseTargetPlan,
} from "../src/_rust-release-workflow.ts";
import {
  captureTaskCommand,
  runLoggedTaskCommand,
  taskCommandSucceeds,
} from "../src/_task-command.ts";

const logger = log.logger("projen:release-assets");
const emoji = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;

interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

interface ReleaseAsset {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

function logReleaseOutput(line: string): void {
  logger.info(line.replace(emoji, ""));
}

function releasePath(): string {
  const llvm = "/opt/homebrew/opt/llvm/bin";
  return [existsSync(llvm) ? llvm : undefined, process.env.PATH].filter(Boolean).join(delimiter);
}

/** Return missing commands required for a complete local release build. */
export function missingLocalReleaseTools(root: string): string[] {
  if (platform() !== "darwin") return ["macOS"];
  const checks: Array<readonly [string, string, readonly string[]]> = [
    ["cargo", "cargo", ["--version"]],
    ["cargo-zigbuild", "cargo", ["zigbuild", "--help"]],
    ["cargo-xwin", "cargo", ["xwin", "--help"]],
    ["node", "node", ["--version"]],
    ["llvm-lib", "llvm-lib", ["--version"]],
    ["rustup", "rustup", ["--version"]],
    ["uv", "uv", ["--version"]],
    ["zig", "zig", ["version"]],
    ["zip", "zip", ["-v"]],
  ];
  return checks
    .filter(
      ([, command, args]) =>
        !taskCommandSucceeds(root, command, args, {
          env: { ...process.env, PATH: releasePath() },
        }),
    )
    .map(([name]) => name);
}

function readConfiguration(root: string): RustReleaseConfiguration {
  return json.parse(
    readFileSync(join(root, ".projen/rust-release.json"), "utf8"),
  ) as RustReleaseConfiguration;
}

/** Whether the synthesized repository has native release targets. */
export function hasLocalReleaseTargets(root: string): boolean {
  const path = join(root, ".projen/rust-release.json");
  return existsSync(path) && readConfiguration(root).targets.length > 0;
}

function buildArguments(
  configuration: RustReleaseConfiguration,
  target: RustReleaseTargetPlan,
  targetName: string,
): string[] {
  return [
    "build",
    "--release",
    "--timings",
    ...(configuration.usesCargoLock ? ["--locked"] : []),
    ...target.packages.flatMap((pkg) => ["--package", pkg]),
    ...target.features.flatMap((feature) => ["--features", feature]),
    "--target",
    targetName,
  ];
}

/** Resolve the native macOS command used for one release target. */
export function localTargetCommand(
  configuration: RustReleaseConfiguration,
  target: RustReleaseTargetPlan,
): CommandInvocation {
  const localTarget = {
    ...target,
    features: [...target.features, ...(target.os === "linux" ? target.localFeatures : [])],
  };
  if (target.os === "darwin") {
    return {
      command: "cargo",
      args: buildArguments(configuration, localTarget, target.cargo),
    };
  }
  if (target.os === "linux") {
    const cargoTarget = target.glibcVersion
      ? `${target.cargo}.${target.glibcVersion}`
      : target.cargo;
    return {
      command: "cargo",
      args: ["zigbuild", ...buildArguments(configuration, localTarget, cargoTarget).slice(1)],
    };
  }
  if (target.os === "win32") {
    return {
      command: "cargo",
      args: ["xwin", "build", ...buildArguments(configuration, localTarget, target.cargo).slice(1)],
    };
  }
  throw new Error(`Unsupported local release target: ${target.os}-${target.cpu}`);
}

function targetEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CARGO_INCREMENTAL: "0",
    PATH: releasePath(),
    RUSTC_WRAPPER: "",
    SCCACHE_DISABLE: "1",
  };
}

function targetBuildEnvironment(
  root: string,
  target: RustReleaseTargetPlan,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (target.os !== "win32" || target.cpu !== "arm64") return env;
  const tools = join(root, "target/release-tools/windows-arm64");
  mkdirSync(tools, { recursive: true });
  const clang = join(tools, "clang");
  writeFileSync(clang, '#!/bin/sh\nexec /opt/homebrew/opt/llvm/bin/clang --driver-mode=cl "$@"\n');
  chmodSync(clang, 0o755);
  return {
    ...env,
    PATH: [tools, env.PATH].filter(Boolean).join(delimiter),
  };
}

function cargoTargetRoot(root: string, env: NodeJS.ProcessEnv): string {
  const metadata = json.parseRecord(
    captureTaskCommand(root, "cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      env,
      check: true,
      stderr: "inherit",
    }),
  );
  if (typeof metadata?.target_directory !== "string") {
    throw new Error("Cargo metadata returned no target directory");
  }
  return metadata.target_directory;
}

function rustHostTarget(root: string, env: NodeJS.ProcessEnv): string {
  const host = /^host:\s+(.+)$/m.exec(
    captureTaskCommand(root, "rustc", ["-vV"], {
      env,
      check: true,
      stderr: "inherit",
    }),
  )?.[1];
  if (!host) throw new Error("rustc did not report a host target");
  return host;
}

function buildBindingGenerators(
  root: string,
  configuration: RustReleaseConfiguration,
  hostTarget: string,
  env: NodeJS.ProcessEnv,
): void {
  if (configuration.bindings.length === 0) return;
  runLoggedTaskCommand(
    root,
    "cargo",
    [
      "build",
      "--release",
      ...(configuration.usesCargoLock ? ["--locked"] : []),
      ...configuration.bindings.flatMap((binding) => ["--package", binding.crate]),
      ...configuration.bindings.flatMap((binding) => [
        "--features",
        `${binding.crate}/uniffi-bindgen`,
      ]),
      "--target",
      hostTarget,
    ],
    { env, onLine: logReleaseOutput },
  );
}

function generatePythonBindings(
  root: string,
  configuration: RustReleaseConfiguration,
  hostTarget: string,
  env: NodeJS.ProcessEnv,
): Map<string, string> {
  const generated = new Map<string, string>();
  for (const binding of configuration.bindings) {
    if (!binding.python) continue;
    const output = join(root, "dist/local-bindings", binding.crate);
    runLoggedTaskCommand(
      root,
      "node",
      [
        ".projen/uniffi-release.mjs",
        "generate-python",
        "--crate",
        binding.crate,
        "--cargo-target",
        hostTarget,
        "--os",
        "darwin",
        "--output",
        output,
      ],
      { env, onLine: logReleaseOutput },
    );
    generated.set(binding.crate, join(output, `${binding.crate.replaceAll("-", "_")}.py`));
  }
  return generated;
}

function packageBindings(
  root: string,
  configuration: RustReleaseConfiguration,
  target: RustReleaseTargetPlan,
  version: string,
  pythonBindings: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  for (const binding of configuration.bindings) {
    runLoggedTaskCommand(
      root,
      "node",
      [
        ".projen/uniffi-release.mjs",
        "build",
        "--crate",
        binding.crate,
        "--node",
        binding.node,
        "--python",
        binding.python,
        "--node-package",
        binding.nodePackage,
        "--python-package",
        binding.pythonPackage,
        "--python-module",
        binding.pythonModule ?? "",
        "--cargo-target",
        target.cargo,
        "--node-triple",
        target.node,
        "--python-tag",
        target.python,
        "--os",
        target.os,
        "--cpu",
        target.cpu,
        "--libc",
        target.libc,
        "--version",
        version,
        "--output",
        `dist/release/${binding.crate}/${target.node}`,
        "--skip-build",
        ...(pythonBindings.has(binding.crate)
          ? ["--python-bindings", pythonBindings.get(binding.crate)!]
          : []),
      ],
      { env, onLine: logReleaseOutput },
    );
  }
}

function packageBinaries(
  root: string,
  configuration: RustReleaseConfiguration,
  target: RustReleaseTargetPlan,
  targetRoot: string,
  env: NodeJS.ProcessEnv,
): void {
  const selected = configuration.binaries.filter(
    (binary) => !binary.excludedOs.includes(target.os),
  );
  for (const crate of new Set(selected.map((binary) => binary.crate))) {
    const output = join(root, "dist/release", crate, target.node, "binary");
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
  }
  for (const binary of selected) {
    const extension = target.os === "win32" ? ".exe" : "";
    const source = resolve(targetRoot, target.cargo, "release", `${binary.binary}${extension}`);
    if (!existsSync(source)) throw new Error(`Missing release binary: ${source}`);
    const output = join(root, "dist/release", binary.crate, target.node, "binary");
    const asset = join(output, releaseBinaryAssetName(binary.binary, target.node, target.os));
    if (target.os === "win32") {
      runLoggedTaskCommand(root, "zip", ["-j", asset, source], {
        env,
        onLine: logReleaseOutput,
      });
    } else {
      runLoggedTaskCommand(root, "tar", ["-C", dirname(source), "-czf", asset, basename(source)], {
        env,
        onLine: logReleaseOutput,
      });
    }
  }
}

function files(root: string, directory: string): string[] {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    return entry.isDirectory() ? files(root, child) : [child];
  });
}

function releaseAssets(root: string): ReleaseAsset[] {
  const allowed = new Set([".tgz", ".whl", ".zip", ".gz"]);
  const found = files(root, "dist/release").filter((path) =>
    [...allowed].some((extension) => path.endsWith(extension)),
  );
  const names = new Set<string>();
  return found.map((path) => {
    const name = basename(path);
    if (names.has(name)) throw new Error(`Duplicate release asset name: ${name}`);
    names.add(name);
    const content = readFileSync(path);
    return {
      name,
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: statSync(path).size,
    };
  });
}

function writeReleaseManifest(
  root: string,
  tag: string | undefined,
  version: string,
): { readonly assets: ReleaseAsset[]; readonly manifest: string } {
  const assets = releaseAssets(root);
  if (assets.length === 0) throw new Error("Local release build produced no assets");
  const manifest = join(root, "dist/release/rust-assets.json");
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        tag,
        version,
        assets: assets.map((asset) => ({ ...asset, path: relative(root, asset.path) })),
      },
      null,
      2,
    )}\n`,
  );
  return { assets, manifest };
}

function uploadAssets(
  root: string,
  tag: string,
  assets: readonly ReleaseAsset[],
  manifest: string,
): void {
  runLoggedTaskCommand(
    root,
    "gh",
    ["release", "upload", tag, ...assets.map((asset) => asset.path), "--clobber"],
    { onLine: logReleaseOutput },
  );
  runLoggedTaskCommand(root, "gh", ["release", "upload", tag, manifest, "--clobber"], {
    onLine: logReleaseOutput,
  });
}

/** Build all configured targets sequentially and optionally upload them. */
export function buildReleaseAssets(options: {
  readonly root: string;
  readonly version: string;
  readonly tag?: string;
  readonly upload?: boolean;
}): void {
  const root = resolve(options.root);
  const missing = missingLocalReleaseTools(root);
  if (missing.length > 0) {
    throw new Error(`Local release build requires: ${missing.join(", ")}`);
  }
  const configuration = readConfiguration(root);
  const env = targetEnvironment();
  const targetRoot = cargoTargetRoot(root, env);
  const hostTarget = rustHostTarget(root, env);
  rmSync(join(root, "dist/release"), { recursive: true, force: true });
  rmSync(join(root, "dist/local-bindings"), { recursive: true, force: true });
  buildBindingGenerators(root, configuration, hostTarget, env);
  const pythonBindings = generatePythonBindings(root, configuration, hostTarget, env);
  for (const target of configuration.targets) {
    runLoggedTaskCommand(root, "rustup", ["target", "add", target.cargo], {
      env,
      onLine: logReleaseOutput,
    });
    const invocation = localTargetCommand(configuration, target);
    const buildEnv = targetBuildEnvironment(root, target, env);
    logger.info("building Rust release target", { target: target.cargo });
    runLoggedTaskCommand(root, invocation.command, invocation.args, {
      env: buildEnv,
      onLine: logReleaseOutput,
    });
    packageBindings(root, configuration, target, options.version, pythonBindings, env);
    packageBinaries(root, configuration, target, targetRoot, env);
  }
  const prepared = writeReleaseManifest(root, options.tag, options.version);
  if (options.upload) {
    if (!options.tag) throw new Error("--tag is required with --upload");
    uploadAssets(root, options.tag, prepared.assets, prepared.manifest);
  }
}

if (import.meta.main) {
  new Command()
    .requiredOption("--version <version>", "release version")
    .option("--root <path>", "repository root")
    .option("--tag <tag>", "GitHub Release tag")
    .option("--upload", "upload assets to the GitHub Release")
    .action((options: { version: string; root?: string; tag?: string; upload?: boolean }) => {
      buildReleaseAssets({
        root: options.root ?? projectUtils.root() ?? process.cwd(),
        version: options.version,
        tag: options.tag,
        upload: options.upload,
      });
    })
    .parse();
}
