load("@prelude//rust:cargo_package.bzl", "cargo")

def _environment(source, directory, package, crate, version):
    return {
        "CARGO_CRATE_NAME": crate,
        "CARGO_MANIFEST_DIR": "%s/crates/%s" % (source, directory),
        "CARGO_PKG_NAME": package,
        "CARGO_PKG_VERSION": version,
    }

def ubran_libraries(source, source_target, version):
    cargo.rust_library(
        name = "common",
        crate = "ubrn_common",
        crate_root = "%s/crates/ubrn_common/src/lib.rs" % source,
        edition = "2021",
        env = _environment(source, "ubrn_common", "ubrn_common", "ubrn_common", "0.1.0"),
        srcs = [source_target],
        named_deps = {
            "anyhow": "//third_party/rust:anyhow",
            "camino": "//third_party/rust:camino",
            "cargo_metadata": "//third_party/rust:cargo_metadata",
            "dunce": "//third_party/rust:dunce",
            "extend": "//third_party/rust:extend",
            "glob": "//third_party/rust:glob",
            "serde": "//third_party/rust:serde",
            "serde_json": "//third_party/rust:serde_json",
            "serde_yaml": "//third_party/rust:serde_yaml",
            "toml": "//third_party/rust:toml",
            "which": "//third_party/rust:which",
        },
    )

    cargo.rust_library(
        name = "bindgen",
        crate = "ubrn_bindgen",
        crate_root = "%s/crates/ubrn_bindgen/src/lib.rs" % source,
        edition = "2021",
        env = _environment(source, "ubrn_bindgen", "ubrn_bindgen", "ubrn_bindgen", "0.1.0"),
        srcs = [source_target],
        named_deps = {
            "anyhow": "//third_party/rust:anyhow",
            "askama": "//third_party/rust:askama",
            "camino": "//third_party/rust:camino",
            "cargo_metadata": "//third_party/rust:cargo_metadata",
            "clap": "//third_party/rust:clap",
            "extend": "//third_party/rust:extend",
            "heck": "//third_party/rust:heck",
            "paste": "//third_party/rust:paste",
            "serde": "//third_party/rust:serde",
            "textwrap": "//third_party/rust:textwrap",
            "toml": "//third_party/rust:toml",
            "ubrn_common": ":common",
            "uniffi_bindgen": "//third_party/rust:uniffi_bindgen",
            "uniffi_meta": "//third_party/rust:uniffi_meta",
        },
    )

    cargo.rust_library(
        name = "cli",
        crate = "ubrn_cli",
        crate_root = "%s/crates/ubrn_cli/src/lib.rs" % source,
        edition = "2021",
        env = _environment(source, "ubrn_cli", "uniffi-bindgen-react-native", "ubrn_cli", version),
        srcs = [source_target],
        visibility = ["PUBLIC"],
        named_deps = {
            "anyhow": "//third_party/rust:anyhow",
            "askama": "//third_party/rust:askama",
            "camino": "//third_party/rust:camino",
            "clap": "//third_party/rust:clap",
            "extend": "//third_party/rust:extend",
            "globset": "//third_party/rust:globset",
            "heck": "//third_party/rust:heck",
            "paste": "//third_party/rust:paste",
            "path_slash": "//third_party/rust:path-slash",
            "pathdiff": "//third_party/rust:pathdiff",
            "serde": "//third_party/rust:serde",
            "serde_json": "//third_party/rust:serde_json",
            "serde_toml_merge": "//third_party/rust:serde-toml-merge",
            "textwrap": "//third_party/rust:textwrap",
            "toml": "//third_party/rust:toml",
            "topological_sort": "//third_party/rust:topological-sort",
            "ubrn_bindgen": ":bindgen",
            "ubrn_common": ":common",
            "uniffi_bindgen": "//third_party/rust:uniffi_bindgen",
            "uniffi_meta": "//third_party/rust:uniffi_meta",
        },
    )
