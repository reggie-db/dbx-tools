#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const FINGERPRINT_SCHEMA = 2;
export const VERSION_SLOT_SCHEMA = 1;
export const VERSION_CAPACITY = 64;

const MAGIC = Buffer.from("DBXVERSION\0\0", "binary");
const RECORD_SIZE = 128;
const VERSION_OFFSET = 16;
const MACH_O_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    stdio: options.stdio,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    throw new Error(stderr.trim() || `${command} exited with status ${result.status}`);
  }
  return result.stdout;
}

export function repositoryRoot(cwd = process.cwd()) {
  return String(commandOutput("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }))
    .trim();
}

export function normalizeManifest(text) {
  const output = [];
  let block = [];
  let heading = "";
  const flush = () => {
    const pathDependency =
      heading.includes("dependencies.") &&
      block.some((line) => line.trimStart().startsWith("path = "));
    const versionOwner = heading === "[package]" || heading === "[workspace.package]";
    output.push(
      ...block.filter(
        (line) =>
          !(
            line.trimStart().startsWith("version = ") &&
            (versionOwner || pathDependency)
          ),
      ),
    );
    block = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("[")) {
      flush();
      heading = line.trim();
    }
    block.push(line);
  }
  flush();
  return output.join("\n");
}

export function normalizeLockfile(text, workspaceVersion) {
  return text
    .split("[[package]]")
    .map((block) => {
      const workspacePackage =
        !/^source = /m.test(block) &&
        block.includes(`version = "${workspaceVersion}"`);
      return workspacePackage
        ? block.replace(`version = "${workspaceVersion}"`, 'version = "<workspace>"')
        : block;
    })
    .join("[[package]]");
}

function workspaceVersion(root) {
  const versionFile = join(root, "VERSION");
  if (existsSync(versionFile)) {
    return readFileSync(versionFile, "utf8").trim();
  }
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  const section = manifest.match(/\[workspace\.package\]([\s\S]*?)(?:\n\s*\[|$)/)?.[1] ?? "";
  return section.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? "";
}

function normalizedInput(root, file, content) {
  const text = content.toString("utf8");
  if (file.endsWith("Cargo.toml")) {
    return Buffer.from(normalizeManifest(text));
  }
  if (file === "Cargo.lock") {
    return Buffer.from(normalizeLockfile(text, workspaceVersion(root)));
  }
  return content;
}

export function sourceHash(root, sources = ["packages/rs"]) {
  const output = commandOutput(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "Cargo.lock",
      "Cargo.toml",
      ".cargo",
      ...sources,
    ],
    { cwd: root },
  );
  const files = Buffer.from(output)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(join(root, file)))
    .filter(
      (file) =>
        file === "Cargo.lock" ||
        file === ".cargo/config.toml" ||
        file.endsWith("Cargo.toml") ||
        file.endsWith(".rs") ||
        file.endsWith("build.rs"),
    )
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const content = readFileSync(join(root, file));
    hash.update(file);
    hash.update(Buffer.from([0]));
    hash.update(normalizedInput(root, file, content));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export function linkerIdentity(target) {
  if (target.includes("windows-msvc")) return "rust-lld";
  if (target.includes("linux")) return "system-linux-linker";
  if (target.includes("apple-darwin")) return "apple-ld";
  return "system-linker";
}

export function targetKey({
  rustSourceHash,
  target,
  targetConfig = "",
  toolchain = "stable",
  rustc,
}) {
  const hash = createHash("sha256");
  for (const value of [
    String(FINGERPRINT_SCHEMA),
    String(VERSION_SLOT_SCHEMA),
    rustSourceHash,
    target,
    targetConfig,
    toolchain,
    rustc ?? "<portable>",
    linkerIdentity(target),
    "release",
    "raw-target-release-v1",
  ]) {
    hash.update(value);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function rustcIdentity() {
  return String(commandOutput("rustc", ["--version", "--verbose"], { encoding: "utf8" }))
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("host: "))
    .join("\n");
}

export function fingerprint({
  root = repositoryRoot(),
  output = ".release/rust-build.json",
  check = false,
  targets,
  toolchain = "stable",
  portable = false,
  sources = ["packages/rs"],
}) {
  if (!targets?.length) {
    throw new Error("at least one --target is required");
  }
  const rustSourceHash = sourceHash(root, sources);
  const rustc = portable ? undefined : rustcIdentity();
  const targetEntries = targets
    .map((specification) => {
      const separator = specification.indexOf("|");
      const target = separator < 0 ? specification : specification.slice(0, separator);
      const targetConfig = separator < 0 ? "" : specification.slice(separator + 1);
      return [
        target,
        targetKey({ rustSourceHash, target, targetConfig, toolchain, rustc }),
      ];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const manifest = {
    schemaVersion: FINGERPRINT_SCHEMA,
    versionSlotSchema: VERSION_SLOT_SCHEMA,
    rustSourceHash,
    targets: Object.fromEntries(targetEntries),
  };
  const outputPath = resolve(root, output);
  if (check) {
    const current = JSON.parse(readFileSync(outputPath, "utf8"));
    const targetsMatch = targetEntries.every(
      ([target, key]) => current.targets?.[target] === key,
    );
    if (
      current.schemaVersion !== manifest.schemaVersion ||
      current.versionSlotSchema !== manifest.versionSlotSchema ||
      current.rustSourceHash !== manifest.rustSourceHash ||
      !targetsMatch
    ) {
      throw new Error(`${outputPath} does not match current Rust inputs`);
    }
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

function isMachO(data) {
  return data.length >= 4 && MACH_O_MAGICS.has(data.subarray(0, 4).toString("hex"));
}

function recordOffsets(data) {
  const offsets = [];
  let offset = data.indexOf(MAGIC);
  while (offset >= 0) {
    if (
      offset + RECORD_SIZE <= data.length &&
      data.readUInt16LE(offset + 12) === VERSION_SLOT_SCHEMA &&
      data.readUInt16LE(offset + 14) <= VERSION_CAPACITY &&
      data.subarray(offset + 80, offset + RECORD_SIZE).every((byte) => byte === 0)
    ) {
      offsets.push(offset);
    }
    offset = data.indexOf(MAGIC, offset + 1);
  }
  return offsets;
}

export function stamp(binary, version) {
  const encoded = Buffer.from(version, "utf8");
  if (!encoded.length || encoded.length > VERSION_CAPACITY) {
    throw new Error(`version must contain 1 to ${VERSION_CAPACITY} bytes`);
  }
  const data = readFileSync(binary);
  const offsets = recordOffsets(data);
  if (!offsets.length) return false;
  if (offsets.length !== 1) {
    throw new Error(`expected one version record in ${binary}, found ${offsets.length}`);
  }
  const offset = offsets[0];
  data.writeUInt16LE(encoded.length, offset + 14);
  data.fill(0, offset + VERSION_OFFSET, offset + VERSION_OFFSET + VERSION_CAPACITY);
  encoded.copy(data, offset + VERSION_OFFSET);
  writeFileSync(binary, data);
  if (isMachO(data)) {
    commandOutput("codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
  }
  return true;
}

function files(root) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  return found.sort();
}

export function stampTree(root, version) {
  let stamped = 0;
  for (const file of files(root)) {
    if (stamp(file, version)) stamped += 1;
  }
  if (!stamped) {
    throw new Error(`no structured version records found under ${root}`);
  }
  process.stdout.write(`stamped ${stamped} native artifact(s)\n`);
  return stamped;
}

function fingerprintCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string", default: ".release/rust-build.json" },
      check: { type: "boolean", default: false },
      target: { type: "string", multiple: true },
      toolchain: { type: "string", default: "stable" },
      portable: { type: "boolean", default: false },
      source: { type: "string", multiple: true },
    },
    strict: true,
  });
  fingerprint({
    output: values.output,
    check: values.check,
    targets: values.target,
    toolchain: values.toolchain,
    portable: values.portable,
    sources: values.source?.length ? values.source : ["packages/rs"],
  });
}

function stampCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      binary: { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (!values.binary || values.version === undefined) {
    throw new Error("stamp requires --binary and --version");
  }
  if (!stamp(values.binary, values.version)) {
    throw new Error(`no structured version record found in ${values.binary}`);
  }
}

function stampTreeCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (!values.root || values.version === undefined) {
    throw new Error("stamp-tree requires --root and --version");
  }
  stampTree(values.root, values.version);
}

export function main(args = process.argv.slice(2)) {
  const [command, ...commandArgs] = args;
  if (command === "fingerprint") return fingerprintCommand(commandArgs);
  if (command === "stamp") return stampCommand(commandArgs);
  if (command === "stamp-tree") return stampTreeCommand(commandArgs);
  throw new Error("expected fingerprint, stamp, or stamp-tree");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
