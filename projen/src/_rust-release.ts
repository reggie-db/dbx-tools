/**
 * Version-independent Rust build fingerprints and format-aware release stamping.
 *
 * This is the private owning TypeScript source. `tasks/build-rust-release.ts` bundles it
 * with `smol-toml` and the shared process helper into the standalone Node
 * artifact copied to consumer `.projen/` directories.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as exec from "@dbx-tools/core/exec";
import { parse, stringify, type TomlTable } from "smol-toml";

export const FINGERPRINT_SCHEMA = 4;
export const VERSION_SLOT_SCHEMA = 1;
export const VERSION_CAPACITY = 64;

const MAGIC = Buffer.from("DBXVERSION\0\0", "binary");
const RECORD_SIZE = 128;
const VERSION_OFFSET = 16;
const EMPTY_RECORD_OFFSET = 80;
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

interface CommandOptions {
  readonly cwd?: string;
  readonly inherit?: boolean;
  readonly check?: boolean;
}

function command(
  commandName: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  const result = exec.spawnSync(commandName, [...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stdout: options.inherit ? "inherit" : "capture",
    stderr: options.inherit ? "inherit" : "capture",
    stdin: "ignore",
    check: options.check ?? true,
  });
  return result.stdout;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeVersionOnlyFields(value: unknown, key?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) removeVersionOnlyFields(item);
    return;
  }
  if (!record(value)) return;
  if (typeof value.path === "string") delete value.version;
  if (key === "package") delete value.version;
  for (const [childKey, child] of Object.entries(value)) {
    removeVersionOnlyFields(child, childKey);
  }
}

/** Canonical TOML representation with workspace-owned release versions removed. */
export function normalizeManifest(text: string): string {
  const document = parse(text) as TomlTable;
  const packageTable = document.package;
  if (record(packageTable)) delete packageTable.version;
  const workspace = document.workspace;
  if (record(workspace) && record(workspace.package)) delete workspace.package.version;
  removeVersionOnlyFields(document);
  return stringify(document);
}

/** Canonical Cargo.lock representation with local package versions normalized. */
export function normalizeLockfile(
  text: string,
  workspaceVersion: string,
  packageNames: ReadonlySet<string> = new Set(),
): string {
  const document = parse(text) as TomlTable;
  const packages = document.package;
  if (Array.isArray(packages)) {
    for (const candidate of packages) {
      if (!record(candidate) || candidate.source !== undefined) continue;
      if (
        (typeof candidate.name === "string" && packageNames.has(candidate.name)) ||
        candidate.version === workspaceVersion
      ) {
        candidate.version = "<workspace>";
      }
    }
  }
  return stringify(document);
}

interface CargoMetadataPackage {
  readonly id: string;
  readonly name: string;
  readonly manifest_path: string;
}

interface CargoMetadata {
  readonly packages: readonly CargoMetadataPackage[];
  readonly workspace_members: readonly string[];
  readonly workspace_root: string;
}

function cargoMetadata(root: string): CargoMetadata {
  const parsed = JSON.parse(
    command("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root }),
  ) as Partial<CargoMetadata>;
  if (
    !Array.isArray(parsed.packages) ||
    !Array.isArray(parsed.workspace_members) ||
    typeof parsed.workspace_root !== "string"
  ) {
    throw new Error("cargo metadata returned an incomplete workspace description");
  }
  return parsed as CargoMetadata;
}

function workspaceVersion(root: string): string {
  const versionFile = join(root, "VERSION");
  if (existsSync(versionFile)) return readFileSync(versionFile, "utf8").trim();
  const document = parse(readFileSync(join(root, "Cargo.toml"), "utf8")) as TomlTable;
  const workspace = document.workspace;
  return record(workspace) &&
    record(workspace.package) &&
    typeof workspace.package.version === "string"
    ? workspace.package.version
    : "";
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function sourceRoots(
  root: string,
  metadata: CargoMetadata,
  sources: readonly string[],
  includeWorkspace: boolean,
): string[] {
  const members = new Set(metadata.workspace_members);
  const discovered = includeWorkspace
    ? metadata.packages
        .filter((candidate) => members.has(candidate.id))
        .map((candidate) => dirname(candidate.manifest_path))
    : [];
  return [...new Set([...discovered, ...sources.map((source) => resolve(root, source))])]
    .map((path) => toPosix(relative(root, path)) || ".")
    .sort();
}

function ignoredInput(path: string): boolean {
  const segments = path.split("/");
  return segments.some(
    (segment) => segment === ".git" || segment === "node_modules" || segment === "target",
  );
}

function walkFiles(root: string, path: string, output: string[]): void {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return;
  const stat = lstatSync(absolute);
  if (!stat.isDirectory()) {
    output.push(toPosix(relative(root, absolute)));
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = toPosix(relative(root, join(absolute, entry.name)));
    if (ignoredInput(child)) continue;
    if (entry.isDirectory()) walkFiles(root, child, output);
    else output.push(child);
  }
}

function inputFiles(root: string, roots: readonly string[]): string[] {
  const pathspecs = [
    "Cargo.toml",
    "Cargo.lock",
    ".cargo",
    "rust-toolchain",
    "rust-toolchain.toml",
    ...roots,
  ];
  const git = exec.spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
    {
      cwd: root,
      stdout: "capture",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
      trim: false,
    },
  );
  const files =
    git.exitCode === 0
      ? git.stdout.split("\0").filter(Boolean)
      : pathspecs.flatMap((path) => {
          const found: string[] = [];
          walkFiles(root, path, found);
          return found;
        });
  return [...new Set(files.map(toPosix))]
    .filter((file) => !ignoredInput(file) && existsSync(join(root, file)))
    .sort();
}

function normalizedInput(
  root: string,
  file: string,
  content: Buffer,
  packageNames: ReadonlySet<string>,
): Buffer {
  if (file.endsWith("Cargo.toml")) return Buffer.from(normalizeManifest(content.toString("utf8")));
  if (file === "Cargo.lock") {
    return Buffer.from(
      normalizeLockfile(content.toString("utf8"), workspaceVersion(root), packageNames),
    );
  }
  return content;
}

/** Hash shared Cargo inputs plus selected or Cargo-discovered workspace sources. */
export function sourceHash(
  root: string,
  sources: readonly string[] = [],
  includeWorkspace = true,
): string {
  const resolvedRoot = resolve(root);
  const metadata = cargoMetadata(resolvedRoot);
  const members = new Set(metadata.workspace_members);
  const packageNames = new Set(
    metadata.packages
      .filter((candidate) => members.has(candidate.id))
      .map((candidate) => candidate.name),
  );
  const hash = createHash("sha256");
  for (const file of inputFiles(
    resolvedRoot,
    sourceRoots(resolvedRoot, metadata, sources, includeWorkspace),
  )) {
    const absolute = join(resolvedRoot, file);
    const stat = lstatSync(absolute);
    hash.update(file);
    hash.update(Buffer.from([0]));
    hash.update(String(stat.mode & 0o111));
    hash.update(Buffer.from([0]));
    hash.update(
      stat.isSymbolicLink()
        ? Buffer.from(readlinkSync(absolute))
        : normalizedInput(resolvedRoot, file, readFileSync(absolute), packageNames),
    );
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export function linkerIdentity(target: string): string {
  if (target.includes("windows-msvc")) return "rust-lld";
  if (target.includes("linux")) return "system-linux-linker";
  if (target.includes("apple-darwin")) return "apple-ld";
  return "system-linker";
}

export interface TargetKeyOptions {
  readonly rustSourceHash: string;
  readonly namespace?: string;
  readonly target: string;
  readonly targetConfig?: string;
  readonly toolchain?: string;
  readonly rustc?: string;
}

export function targetKey({
  rustSourceHash,
  namespace = "workspace",
  target,
  targetConfig = "",
  toolchain = "stable",
  rustc,
}: TargetKeyOptions): string {
  const hash = createHash("sha256");
  for (const value of [
    String(FINGERPRINT_SCHEMA),
    String(VERSION_SLOT_SCHEMA),
    namespace,
    rustSourceHash,
    target,
    targetConfig,
    toolchain,
    rustc ?? "<portable>",
    linkerIdentity(target),
    "release",
    "raw-target-release-v2",
  ]) {
    hash.update(value);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function rustcIdentity(): string {
  return command("rustc", ["--version", "--verbose"])
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("host: "))
    .join("\n");
}

export interface FingerprintOptions {
  readonly root?: string;
  readonly output?: string;
  readonly check?: boolean;
  readonly targets: readonly string[];
  readonly toolchain?: string;
  readonly portable?: boolean;
  readonly sources?: readonly string[];
  readonly sourceOnly?: boolean;
  readonly namespace?: string;
}

export interface RustBuildFingerprint {
  readonly schemaVersion: number;
  readonly versionSlotSchema: number;
  readonly namespace: string;
  readonly rustSourceHash: string;
  readonly targets: Readonly<Record<string, string>>;
}

export function fingerprint({
  root = process.cwd(),
  output = ".release/rust-build.json",
  check = false,
  targets,
  toolchain = "stable",
  portable = false,
  sources = [],
  sourceOnly = false,
  namespace = "workspace",
}: FingerprintOptions): RustBuildFingerprint {
  if (!targets.length) throw new Error("at least one --target is required");
  const resolvedRoot = resolve(root);
  const rustSourceHash = sourceHash(resolvedRoot, sources, !sourceOnly);
  const rustc = portable ? undefined : rustcIdentity();
  const targetEntries = targets
    .map((specification) => {
      const separator = specification.indexOf("|");
      const target = separator < 0 ? specification : specification.slice(0, separator);
      const targetConfig = separator < 0 ? "" : specification.slice(separator + 1);
      return [
        target,
        targetKey({ rustSourceHash, namespace, target, targetConfig, toolchain, rustc }),
      ] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const manifest = {
    schemaVersion: FINGERPRINT_SCHEMA,
    versionSlotSchema: VERSION_SLOT_SCHEMA,
    namespace,
    rustSourceHash,
    targets: Object.fromEntries(targetEntries),
  };
  const outputPath = resolve(resolvedRoot, output);
  if (check) {
    const current = JSON.parse(readFileSync(outputPath, "utf8")) as Partial<RustBuildFingerprint>;
    const targetsMatch = targetEntries.every(([target, key]) => current.targets?.[target] === key);
    if (
      current.schemaVersion !== manifest.schemaVersion ||
      current.versionSlotSchema !== manifest.versionSlotSchema ||
      current.namespace !== manifest.namespace ||
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

type BinaryFormat = "elf" | "macho" | "pe";

const SECTION_BY_FORMAT: Readonly<Record<BinaryFormat, string>> = {
  elf: ".dbxversion",
  macho: "__DATA,__dbxver",
  pe: ".dbxver",
};

function binaryFormat(data: Buffer): BinaryFormat | undefined {
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return "elf";
  }
  if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "MZ") return "pe";
  if (data.length >= 4 && MACH_O_MAGICS.has(data.subarray(0, 4).toString("hex"))) return "macho";
  return undefined;
}

function binaryHeader(path: string): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return header.subarray(0, readSync(descriptor, header, 0, header.length, 0));
  } finally {
    closeSync(descriptor);
  }
}

function executableOnPath(name: string): boolean {
  return (
    exec.spawnSync(process.platform === "win32" ? "where" : "which", [name], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    }).exitCode === 0
  );
}

function llvmObjcopy(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.LLVM_OBJCOPY) return process.env.LLVM_OBJCOPY;
  if (executableOnPath("llvm-objcopy")) return "llvm-objcopy";
  const verbose = command("rustc", ["--version", "--verbose"]);
  const host = /^host:\s*(.+)$/m.exec(verbose)?.[1];
  const sysroot = command("rustc", ["--print", "sysroot"]);
  if (host) {
    const candidate = join(
      sysroot,
      "lib",
      "rustlib",
      host,
      "bin",
      process.platform === "win32" ? "llvm-objcopy.exe" : "llvm-objcopy",
    );
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("llvm-objcopy is unavailable; install the Rust llvm-tools-preview component");
}

function validRecord(data: Buffer, binary: string, section: string): void {
  if (data.length !== RECORD_SIZE) {
    throw new Error(
      `version section ${section} in ${binary} must be ${RECORD_SIZE} bytes, got ${data.length}`,
    );
  }
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`version section ${section} in ${binary} has invalid magic`);
  }
  if (data.readUInt16LE(12) !== VERSION_SLOT_SCHEMA || data.readUInt16LE(14) > VERSION_CAPACITY) {
    throw new Error(`version section ${section} in ${binary} has an unsupported record schema`);
  }
  if (!data.subarray(EMPTY_RECORD_OFFSET).every((byte) => byte === 0)) {
    throw new Error(`version section ${section} in ${binary} has non-zero reserved bytes`);
  }
}

export interface StampOptions {
  readonly objcopy?: string;
  readonly codesign?: string;
}

export function stamp(binary: string, version: string, options: StampOptions = {}): boolean {
  const encoded = Buffer.from(version, "utf8");
  if (!encoded.length || encoded.length > VERSION_CAPACITY) {
    throw new Error(`version must contain 1 to ${VERSION_CAPACITY} bytes`);
  }
  const format = binaryFormat(binaryHeader(binary));
  if (!format) return false;
  const section = SECTION_BY_FORMAT[format];
  const objcopy = llvmObjcopy(options.objcopy);
  const temporary = mkdtempSync(join(tmpdir(), "dbx-rust-version-"));
  const recordPath = join(temporary, "record.bin");
  const mode = statSync(binary).mode;
  try {
    const dumped = exec.spawnSync(objcopy, ["--dump-section", `${section}=${recordPath}`, binary], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      check: false,
    });
    if (dumped.exitCode !== 0 || !existsSync(recordPath)) return false;
    const data = readFileSync(recordPath);
    validRecord(data, binary, section);
    data.writeUInt16LE(encoded.length, 14);
    data.fill(0, VERSION_OFFSET, VERSION_OFFSET + VERSION_CAPACITY);
    encoded.copy(data, VERSION_OFFSET);
    writeFileSync(recordPath, data);
    command(objcopy, ["--update-section", `${section}=${recordPath}`, binary], { inherit: true });
    chmodSync(binary, mode);
    if (format === "macho") {
      command(options.codesign ?? "codesign", ["--force", "--sign", "-", binary], {
        inherit: true,
      });
    }
    return true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function files(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  return found.sort();
}

export function stampTree(root: string, version: string, options: StampOptions = {}): number {
  let stamped = 0;
  for (const file of files(root)) if (stamp(file, version, options)) stamped += 1;
  if (!stamped) throw new Error(`no structured version sections found under ${root}`);
  process.stdout.write(`stamped ${stamped} native artifact(s)\n`);
  return stamped;
}

function fingerprintCommand(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      root: { type: "string", default: process.cwd() },
      output: { type: "string", default: ".release/rust-build.json" },
      check: { type: "boolean", default: false },
      target: { type: "string", multiple: true },
      toolchain: { type: "string", default: "stable" },
      portable: { type: "boolean", default: false },
      source: { type: "string", multiple: true },
      "source-only": { type: "boolean", default: false },
      namespace: { type: "string", default: "workspace" },
    },
    strict: true,
  });
  fingerprint({
    root: values.root,
    output: values.output,
    check: values.check,
    targets: values.target ?? [],
    toolchain: values.toolchain,
    portable: values.portable,
    sources: values.source ?? [],
    sourceOnly: values["source-only"],
    namespace: values.namespace,
  });
}

function stampCommand(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      binary: { type: "string" },
      version: { type: "string" },
      objcopy: { type: "string" },
    },
    strict: true,
  });
  if (!values.binary || values.version === undefined) {
    throw new Error("stamp requires --binary and --version");
  }
  if (!stamp(values.binary, values.version, { objcopy: values.objcopy })) {
    throw new Error(`no structured version section found in ${values.binary}`);
  }
}

function stampTreeCommand(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: {
      root: { type: "string" },
      version: { type: "string" },
      objcopy: { type: "string" },
    },
    strict: true,
  });
  if (!values.root || values.version === undefined) {
    throw new Error("stamp-tree requires --root and --version");
  }
  stampTree(values.root, values.version, { objcopy: values.objcopy });
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const [subcommand, ...commandArgs] = args;
  if (subcommand === "fingerprint") return fingerprintCommand(commandArgs);
  if (subcommand === "stamp") return stampCommand(commandArgs);
  if (subcommand === "stamp-tree") return stampTreeCommand(commandArgs);
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
