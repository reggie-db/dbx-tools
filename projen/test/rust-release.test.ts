import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  });

  it("stamps one structured binary record and complete trees", () => {
    const directory = temporaryDirectory("rust-release-stamp-");
    const first = join(directory, "first.bin");
    const secondDirectory = join(directory, "nested");
    const second = join(secondDirectory, "second.bin");
    mkdirSync(secondDirectory);
    writeFileSync(
      first,
      Buffer.concat([Buffer.from("header"), versionRecord(), Buffer.from("tail")]),
    );
    writeFileSync(second, Buffer.concat([Buffer.from("other"), versionRecord()]));
    writeFileSync(join(directory, "plain.txt"), "not a native artifact");

    assert.equal(stamp(first, "2.3.4"), true);
    assert.equal(stampTree(directory, "3.4.5"), 2);
    const stamped = readFileSync(first);
    const offset = stamped.indexOf(Buffer.from("DBXVERSION\0\0", "binary"));
    assert.equal(stamped.readUInt16LE(offset + 14), 5);
    assert.equal(stamped.subarray(offset + 16, offset + 21).toString("utf8"), "3.4.5");
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
});
