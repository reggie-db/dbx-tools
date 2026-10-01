use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use clap::{Parser, Subcommand};
use object::{BinaryFormat, Object, ObjectSection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const FINGERPRINT_SCHEMA: u32 = 2;
const VERSION_SLOT_SCHEMA: u32 = 1;
const MAGIC: &[u8; 12] = b"DBXVERSION\0\0";
const RECORD_SIZE: usize = 128;
const VERSION_OFFSET: usize = 16;
const VERSION_CAPACITY: usize = 64;

#[derive(Parser)]
#[command(name = "dbx-release-tools")]
struct Cli {
    #[command(subcommand)]
    command: ReleaseCommand,
}

#[derive(Subcommand)]
enum ReleaseCommand {
    Fingerprint {
        #[arg(long, default_value = ".release/rust-build.json")]
        output: PathBuf,
        #[arg(long)]
        check: bool,
        #[arg(long, required = true)]
        target: Vec<String>,
        #[arg(long, default_value = "stable")]
        toolchain: String,
        #[arg(long)]
        portable: bool,
    },
    Stamp {
        #[arg(long)]
        binary: PathBuf,
        #[arg(long)]
        version: String,
    },
    StampTree {
        #[arg(long)]
        root: PathBuf,
        #[arg(long)]
        version: String,
    },
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RustBuildManifest {
    schema_version: u32,
    version_slot_schema: u32,
    rust_source_hash: String,
    targets: BTreeMap<String, String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    match Cli::parse().command {
        ReleaseCommand::Fingerprint {
            output,
            check,
            target,
            toolchain,
            portable,
        } => fingerprint(&output, check, &target, &toolchain, portable),
        ReleaseCommand::Stamp { binary, version } => {
            if !stamp(&binary, &version)? {
                return Err(format!(
                    "no structured version section found in {}",
                    binary.display()
                )
                .into());
            }
            Ok(())
        }
        ReleaseCommand::StampTree { root, version } => stamp_tree(&root, &version),
    }
}

fn fingerprint(
    output: &Path,
    check: bool,
    targets: &[String],
    toolchain: &str,
    portable: bool,
) -> Result<(), Box<dyn Error>> {
    let root = repository_root()?;
    let rust_source_hash = source_hash(&root)?;
    let rustc = if portable {
        None
    } else {
        Some(rustc_identity()?)
    };
    let target_keys = targets
        .iter()
        .map(|target_spec| {
            let (target, target_config) = target_spec.split_once('|').unwrap_or((target_spec, ""));
            (
                target.to_owned(),
                target_key(
                    &rust_source_hash,
                    target,
                    target_config,
                    toolchain,
                    rustc.as_deref(),
                ),
            )
        })
        .collect();
    let manifest = RustBuildManifest {
        schema_version: FINGERPRINT_SCHEMA,
        version_slot_schema: VERSION_SLOT_SCHEMA,
        rust_source_hash,
        targets: target_keys,
    };
    let rendered = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
    let output = root.join(output);
    if check {
        let current: RustBuildManifest = serde_json::from_slice(&fs::read(&output)?)?;
        let targets_match = manifest
            .targets
            .iter()
            .all(|(target, key)| current.targets.get(target) == Some(key));
        if current.schema_version != manifest.schema_version
            || current.version_slot_schema != manifest.version_slot_schema
            || current.rust_source_hash != manifest.rust_source_hash
            || !targets_match
        {
            return Err(format!("{} does not match current Rust inputs", output.display()).into());
        }
    } else {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(output, rendered)?;
    }
    Ok(())
}

fn target_key(
    rust_source_hash: &str,
    target: &str,
    target_config: &str,
    toolchain: &str,
    rustc: Option<&str>,
) -> String {
    let mut hash = Sha256::new();
    for value in [
        FINGERPRINT_SCHEMA.to_string(),
        VERSION_SLOT_SCHEMA.to_string(),
        rust_source_hash.to_owned(),
        target.to_owned(),
        target_config.to_owned(),
        toolchain.to_owned(),
        rustc.unwrap_or("<portable>").to_owned(),
        linker_identity(target).to_owned(),
        "release".to_owned(),
        "raw-target-release-v1".to_owned(),
    ] {
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

fn rustc_identity() -> Result<String, Box<dyn Error>> {
    let output = Command::new("rustc")
        .arg("--version")
        .arg("--verbose")
        .output()?;
    if !output.status.success() {
        return Err("failed to resolve the Rust compiler identity".into());
    }
    Ok(String::from_utf8(output.stdout)?
        .lines()
        .filter(|line| !line.starts_with("host: "))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn repository_root() -> Result<PathBuf, Box<dyn Error>> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if !output.status.success() {
        return Err("release tools require a Git repository".into());
    }
    Ok(PathBuf::from(String::from_utf8(output.stdout)?.trim()))
}

fn source_hash(root: &Path) -> Result<String, Box<dyn Error>> {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "Cargo.lock",
            "Cargo.toml",
            ".cargo",
            "packages/rs",
        ])
        .output()?;
    if !output.status.success() {
        return Err("failed to list tracked Rust inputs".into());
    }
    let mut files = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()))
        .collect::<Result<Vec<_>, _>>()?;
    files.retain(|path| {
        path == "Cargo.lock"
            || path == ".cargo/config.toml"
            || path.ends_with("Cargo.toml")
            || path.ends_with(".rs")
            || path.ends_with("build.rs")
    });
    files.sort();
    let mut hash = Sha256::new();
    for file in files {
        let content = fs::read(root.join(&file))?;
        hash.update(file.as_bytes());
        hash.update([0]);
        hash.update(normalize_version_only_input(root, &file, &content));
        hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn normalize_version_only_input(root: &Path, file: &str, content: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(content) else {
        return content.to_vec();
    };
    if file.ends_with("Cargo.toml") {
        return normalize_manifest(text).into_bytes();
    }
    if file == "Cargo.lock" {
        let workspace_version = fs::read_to_string(root.join("VERSION")).unwrap_or_default();
        return normalize_lockfile(text, workspace_version.trim()).into_bytes();
    }
    content.to_vec()
}

fn normalize_manifest(text: &str) -> String {
    let mut output = Vec::new();
    let mut block = Vec::new();
    let mut heading = String::new();
    let flush = |heading: &str, block: &mut Vec<&str>, output: &mut Vec<String>| {
        let path_dependency = heading.contains("dependencies.")
            && block
                .iter()
                .any(|line| line.trim_start().starts_with("path = "));
        let version_owner = matches!(heading, "[package]" | "[workspace.package]");
        output.extend(
            block
                .drain(..)
                .filter(|line| {
                    !(line.trim_start().starts_with("version = ")
                        && (version_owner || path_dependency))
                })
                .map(str::to_owned),
        );
    };
    for line in text.lines() {
        if line.trim_start().starts_with('[') {
            flush(&heading, &mut block, &mut output);
            heading = line.trim().to_owned();
        }
        block.push(line);
    }
    flush(&heading, &mut block, &mut output);
    output.join("\n")
}

fn normalize_lockfile(text: &str, workspace_version: &str) -> String {
    text.split("[[package]]")
        .map(|block| {
            let workspace_package = block.lines().any(|line| {
                line.trim_start()
                    .strip_prefix("name = \"")
                    .is_some_and(|name| name.starts_with("dbx-tools-"))
            });
            if workspace_package {
                block.replace(
                    &format!("version = \"{workspace_version}\""),
                    "version = \"<workspace>\"",
                )
            } else {
                block.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("[[package]]")
}

fn linker_identity(target: &str) -> &'static str {
    if target.contains("windows-msvc") {
        "rust-lld"
    } else if target.contains("linux") {
        "system-linux-linker"
    } else if target.contains("apple-darwin") {
        "apple-ld"
    } else {
        "system-linker"
    }
}

fn stamp_tree(root: &Path, version: &str) -> Result<(), Box<dyn Error>> {
    let mut stamped = 0;
    for path in files(root)? {
        if stamp(&path, version)? {
            stamped += 1;
        }
    }
    if stamped == 0 {
        return Err(format!(
            "no structured version sections found under {}",
            root.display()
        )
        .into());
    }
    println!("stamped {stamped} native artifact(s)");
    Ok(())
}

fn files(root: &Path) -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut pending = vec![root.to_path_buf()];
    let mut found = Vec::new();
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            } else if entry.file_type()?.is_file() {
                found.push(entry.path());
            }
        }
    }
    Ok(found)
}

fn stamp(path: &Path, version: &str) -> Result<bool, Box<dyn Error>> {
    if version.is_empty() || version.len() > VERSION_CAPACITY {
        return Err(format!("version must contain 1 to {VERSION_CAPACITY} bytes").into());
    }
    let mut data = fs::read(path)?;
    let Ok(file) = object::File::parse(&*data) else {
        return Ok(false);
    };
    let is_macho = file.format() == BinaryFormat::MachO;
    let ranges = file
        .sections()
        .filter_map(|section| {
            let name = section.name().ok()?;
            if !matches!(name, ".dbxversion" | ".dbxver" | "__dbxver") {
                return None;
            }
            section.file_range()
        })
        .collect::<Vec<_>>();
    drop(file);
    if ranges.is_empty() {
        return Ok(false);
    }
    if ranges.len() != 1 {
        return Err(format!(
            "expected one version section in {}, found {}",
            path.display(),
            ranges.len()
        )
        .into());
    }
    let (offset, size) = ranges[0];
    if usize::try_from(size)? != RECORD_SIZE {
        return Err(format!("unexpected version section size in {}", path.display()).into());
    }
    let start = usize::try_from(offset)?;
    let record = &mut data[start..start + RECORD_SIZE];
    if &record[..MAGIC.len()] != MAGIC || u16::from_le_bytes([record[12], record[13]]) != 1 {
        return Err(format!("invalid version record in {}", path.display()).into());
    }
    record[14..16].copy_from_slice(&(version.len() as u16).to_le_bytes());
    record[VERSION_OFFSET..VERSION_OFFSET + VERSION_CAPACITY].fill(0);
    record[VERSION_OFFSET..VERSION_OFFSET + version.len()].copy_from_slice(version.as_bytes());
    fs::write(path, data)?;
    if is_macho {
        let status = Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(path)
            .status()?;
        if !status.success() {
            return Err(format!("failed to re-sign {} after stamping", path.display()).into());
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_target_keys_ignore_host_compiler_identity() {
        let portable = target_key("source", "x86_64-unknown-linux-gnu", "", "stable", None);
        assert_eq!(
            portable,
            target_key("source", "x86_64-unknown-linux-gnu", "", "stable", None,)
        );
        assert_ne!(
            portable,
            target_key(
                "source",
                "x86_64-unknown-linux-gnu",
                "",
                "stable",
                Some("rustc 1.94.1"),
            )
        );
    }

    #[test]
    fn runtime_target_keys_change_with_compiler_identity() {
        assert_ne!(
            target_key(
                "source",
                "aarch64-apple-darwin",
                "",
                "stable",
                Some("rustc 1.94.1"),
            ),
            target_key(
                "source",
                "aarch64-apple-darwin",
                "",
                "stable",
                Some("rustc 1.95.0"),
            )
        );
    }
}
