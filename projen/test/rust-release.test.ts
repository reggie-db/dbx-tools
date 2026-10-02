import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  VERSION_CAPACITY,
  fingerprint,
  normalizeLockfile,
  normalizeManifest,
  stamp,
  stampTree,
  targetKey,
} from "../tasks/rust-release.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function versionRecord(version = "0.0.0"): Buffer {
  const record = Buffer.alloc(128);
  Buffer.from("DBXVERSION\0\0", "binary").copy(record);
  record.writeUInt16LE(1, 12);
  record.writeUInt16LE(Buffer.byteLength(version), 14);
  record.write(version, 16, VERSION_CAPACITY, "utf8");
  return record;
}

const SECTION_BY_HEADER = [
  { name: "ELF", header: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), section: ".dbxversion" },
  { name: "PE", header: Buffer.from("MZ"), section: ".dbxver" },
  {
    name: "Mach-O",
    header: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    section: "__DATA,__dbxver",
  },
] as const;

function fakeObjcopy(directory: string): string {
  const path = join(directory, "llvm-objcopy");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [operation, assignment, binary] = process.argv.slice(2);
const separator = assignment.indexOf("=");
const section = assignment.slice(0, separator);
const file = assignment.slice(separator + 1);
const statePath = binary + ".sections.json";
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
appendFileSync(binary + ".objcopy.log", JSON.stringify({ operation, section }) + "\\n");
if (operation === "--dump-section") {
  if (typeof state[section] !== "string") process.exit(1);
  writeFileSync(file, Buffer.from(state[section], "base64"));
} else if (operation === "--update-section") {
  state[section] = readFileSync(file).toString("base64");
  writeFileSync(statePath, JSON.stringify(state));
  chmodSync(binary, 0o600);
} else {
  process.exit(2);
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeCodesign(directory: string): string {
  const path = join(directory, "codesign");
  const log = join(directory, "codesign.log");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function writeSection(binary: string, section: string, data: Buffer): void {
  writeFileSync(`${binary}.sections.json`, JSON.stringify({ [section]: data.toString("base64") }));
}

function readSection(binary: string, section: string): Buffer {
  const state = JSON.parse(readFileSync(`${binary}.sections.json`, "utf8")) as Record<
    string,
    string
  >;
  return Buffer.from(state[section]!, "base64");
}

describe("Rust release helper", () => {
  it("normalizes only release-version fields", () => {
    const manifest = [
      "[package]",
      'name = "fixture-core"',
      'version = "1.2.3"',
      "",
      "[dependencies.external]",
      'version = "4"',
      "",
      "[dependencies.internal]",
      'version = "1.2.3"',
      'path = "../internal"',
    ].join("\n");
    const normalized = normalizeManifest(manifest);
    assert.doesNotMatch(normalized, /version = "1\.2\.3"/);
    assert.match(normalized, /version = "4"/);

    const lock = [
      "version = 4",
      "",
      "[[package]]",
      'name = "fixture-core"',
      'version = "1.2.3"',
      "",
      "[[package]]",
      'name = "external"',
      'version = "1.2.3"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join("\n");
    const normalizedLock = normalizeLockfile(lock, "1.2.3");
    assert.match(normalizedLock, /name = "fixture-core"\nversion = "<workspace>"/);
    assert.match(normalizedLock, /name = "external"\nversion = "1\.2\.3"/);
  });

  it("keeps portable keys stable and compiler-aware keys distinct", () => {
    const options = {
      rustSourceHash: "source",
      target: "aarch64-apple-darwin",
      toolchain: "stable",
    };
    assert.equal(targetKey(options), targetKey(options));
    assert.notEqual(
      targetKey({ ...options, rustc: "rustc 1.94.1" }),
      targetKey({ ...options, rustc: "rustc 1.95.0" }),
    );
    assert.notEqual(
      targetKey({ ...options, namespace: "uniffi" }),
      targetKey({ ...options, namespace: "binaries" }),
    );
  });

  it("stamps exact format sections, preserves modes, and re-signs Mach-O", () => {
    const directory = temporaryDirectory("rust-release-stamp-");
    const objcopy = fakeObjcopy(directory);
    const codesign = fakeCodesign(directory);
    const binaries = SECTION_BY_HEADER.map(({ name, header, section }) => {
      const binary = join(directory, `${name}.bin`);
      writeFileSync(binary, Buffer.concat([header, versionRecord(), versionRecord()]));
      chmodSync(binary, 0o751);
      writeSection(binary, section, versionRecord());
      assert.equal(stamp(binary, "2.3.4", { objcopy, codesign }), true);
      assert.equal(statSync(binary).mode & 0o777, 0o751);
      const stamped = readSection(binary, section);
      assert.equal(stamped.readUInt16LE(14), 5);
      assert.equal(stamped.subarray(16, 21).toString("utf8"), "2.3.4");
      assert.deepEqual(
        readFileSync(`${binary}.objcopy.log`, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        [
          { operation: "--dump-section", section },
          { operation: "--update-section", section },
        ],
      );
      return binary;
    });
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "codesign.log"), "utf8").trim()), [
      "--force",
      "--sign",
      "-",
      binaries[2],
    ]);
  });

  it("stamps complete trees and rejects absent or malformed structured sections", () => {
    const directory = temporaryDirectory("rust-release-tree-");
    const objcopy = fakeObjcopy(directory);
    const nested = join(directory, "nested");
    mkdirSync(nested);
    for (const [index, { header, section }] of SECTION_BY_HEADER.slice(0, 2).entries()) {
      const binary = join(index ? nested : directory, `binary-${index}`);
      writeFileSync(binary, header);
      writeSection(binary, section, versionRecord());
    }
    writeFileSync(join(directory, "plain.txt"), "not a native artifact");
    assert.equal(stampTree(directory, "3.4.5", { objcopy }), 2);

    const missing = join(directory, "missing-section");
    writeFileSync(missing, SECTION_BY_HEADER[0].header);
    assert.equal(stamp(missing, "1.0.0", { objcopy }), false);

    const malformed = join(directory, "malformed-section");
    writeFileSync(malformed, SECTION_BY_HEADER[0].header);
    writeSection(malformed, SECTION_BY_HEADER[0].section, Buffer.alloc(127));
    assert.throws(() => stamp(malformed, "1.0.0", { objcopy }), /must be 128 bytes/);

    const rawMagicOnly = join(directory, "raw-magic-only");
    writeFileSync(
      rawMagicOnly,
      Buffer.concat([SECTION_BY_HEADER[0].header, versionRecord(), versionRecord()]),
    );
    assert.equal(stamp(rawMagicOnly, "1.0.0", { objcopy }), false);
    assert.throws(() => stamp(missing, "x".repeat(VERSION_CAPACITY + 1), { objcopy }), /1 to 64/);
  });

  it("hashes arbitrary Rust roots without hard-coded package names", () => {
    const directory = temporaryDirectory("rust-release-fingerprint-");
    mkdirSync(join(directory, "native/core/src"), { recursive: true });
    writeFileSync(join(directory, "VERSION"), "1.2.3\n");
    writeFileSync(
      join(directory, "Cargo.toml"),
      '[workspace]\nmembers = ["native/core"]\n\n[workspace.package]\nversion = "1.2.3"\n',
    );
    writeFileSync(
      join(directory, "native/core/Cargo.toml"),
      '[package]\nname = "consumer-core"\nversion.workspace = true\n',
    );
    writeFileSync(join(directory, "native/core/src/lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(join(directory, "native/core/schema.json"), '{"revision":1}\n');
    writeFileSync(
      join(directory, "Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "consumer-core"\nversion = "1.2.3"\n',
    );
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });

    const first = fingerprint({
      root: directory,
      output: ".release/rust-build.json",
      targets: ["x86_64-unknown-linux-gnu|"],
      portable: true,
      sources: ["native"],
    });
    writeFileSync(join(directory, "native/core/schema.json"), '{"revision":2}\n');
    const assetChanged = fingerprint({
      root: directory,
      output: ".release/rust-build-asset.json",
      targets: ["x86_64-unknown-linux-gnu|"],
      portable: true,
      sources: ["native"],
    });
    assert.notEqual(first.rustSourceHash, assetChanged.rustSourceHash);
    writeFileSync(join(directory, "native/core/schema.json"), '{"revision":1}\n');
    writeFileSync(join(directory, "VERSION"), "1.2.4\n");
    writeFileSync(
      join(directory, "Cargo.toml"),
      '[workspace]\nmembers = ["native/core"]\n\n[workspace.package]\nversion = "1.2.4"\n',
    );
    writeFileSync(
      join(directory, "Cargo.lock"),
      'version = 4\n\n[[package]]\nname = "consumer-core"\nversion = "1.2.4"\n',
    );
    const second = fingerprint({
      root: directory,
      output: ".release/rust-build-next.json",
      targets: ["x86_64-unknown-linux-gnu|"],
      portable: true,
      sources: ["native"],
    });
    assert.equal(first.rustSourceHash, second.rustSourceHash);
    assert.deepEqual(first.targets, second.targets);
  });

  it("isolates selected-source fingerprints from unrelated workspace crates", () => {
    const directory = temporaryDirectory("rust-release-scoped-fingerprint-");
    mkdirSync(join(directory, "native/core/src"), { recursive: true });
    mkdirSync(join(directory, "native/tool/src"), { recursive: true });
    writeFileSync(
      join(directory, "Cargo.toml"),
      '[workspace]\nmembers = ["native/core", "native/tool"]\n',
    );
    writeFileSync(
      join(directory, "native/core/Cargo.toml"),
      '[package]\nname = "core"\nversion = "0.1.0"\n',
    );
    writeFileSync(
      join(directory, "native/tool/Cargo.toml"),
      '[package]\nname = "tool"\nversion = "0.1.0"\n',
    );
    writeFileSync(join(directory, "native/core/src/lib.rs"), "pub fn core() {}\n");
    writeFileSync(join(directory, "native/tool/src/lib.rs"), "pub fn tool() {}\n");
    writeFileSync(join(directory, "Cargo.lock"), "version = 4\n");
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });

    const scoped = () =>
      fingerprint({
        root: directory,
        output: join(directory, `.release/${Math.random()}.json`),
        namespace: "uniffi",
        targets: ["x86_64-unknown-linux-gnu|"],
        portable: true,
        sources: ["native/core"],
        sourceOnly: true,
      });
    const first = scoped();
    writeFileSync(join(directory, "native/tool/src/lib.rs"), "pub fn tool() { panic!() }\n");
    const unrelatedChanged = scoped();
    assert.equal(first.rustSourceHash, unrelatedChanged.rustSourceHash);
    assert.deepEqual(first.targets, unrelatedChanged.targets);

    writeFileSync(join(directory, "native/core/src/lib.rs"), "pub fn core() { panic!() }\n");
    const selectedChanged = scoped();
    assert.notEqual(first.rustSourceHash, selectedChanged.rustSourceHash);
    assert.equal(first.namespace, "uniffi");
  });
});
