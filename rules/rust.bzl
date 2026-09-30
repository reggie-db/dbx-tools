load("//:Cargo.toml", workspace_manifest = "value")
load(":uniffi.bzl", "uniffi_bindings")

def _dependencies(manifest, section = "dependencies", third_party = "//third_party/rust"):
    result = {}
    for name, definition in manifest.get(section, {}).items():
        if type(definition) == "dict" and definition.get("path"):
            package = definition["path"].split("/")[-1]
            target = "//packages/rs/" + package + ":crate"
        else:
            package = definition.get("package", name) if type(definition) == "dict" else name
            target = third_party + ":" + package
        result[name.replace("-", "_")] = target
    return result

def dbx_rust(manifest, third_party = "//third_party/rust"):
    package = manifest["package"]
    version = package.get("version")
    if type(version) == "dict":
        version = workspace_manifest["workspace"]["package"]["version"]
    dependencies = _dependencies(manifest, third_party = third_party)
    sources = native.glob(["src/**", "assets/**"]) + ["Cargo.toml"]
    environment = {
        "CARGO_MANIFEST_DIR": ".",
        "CARGO_PKG_NAME": package["name"],
        "CARGO_PKG_VERSION": version,
    }
    common = {
        "edition": "2021",
        "visibility": ["PUBLIC"],
    }
    if "lib" in manifest:
        library_environment = environment | {"CARGO_CRATE_NAME": manifest["lib"]["name"]}
        native.rust_library(name = "crate", crate = manifest["lib"]["name"], crate_root = "src/lib.rs", srcs = sources, env = library_environment, named_deps = dependencies, **common)
        native.rust_test(name = "test", crate = manifest["lib"]["name"], crate_root = "src/lib.rs", srcs = sources, named_deps = dependencies | _dependencies(manifest, "dev-dependencies", third_party), edition = "2021", env = library_environment)
    for binary in manifest.get("bin", []):
        name = "bindgen" if binary["path"] == "uniffi-bindgen.rs" else "binary"
        crate = binary["name"].replace("-", "_")
        binary_dependencies = dict(dependencies)
        if "lib" in manifest:
            binary_dependencies[manifest["lib"]["name"]] = ":crate"
        native.rust_binary(name = name, crate = crate, crate_root = binary["path"], srcs = native.glob(["src/**", "assets/**", "uniffi-bindgen.rs"]) + ["Cargo.toml"], env = environment | {"CARGO_BIN_NAME": binary["name"], "CARGO_CRATE_NAME": crate}, named_deps = binary_dependencies, **common)
    if native.glob(["uniffi.toml"]):
        binding = package["name"].removeprefix("dbx-tools-")
        uniffi_bindings(name = "bindings", library = ":crate[cdylib]", generator = ":bindgen", config = "uniffi.toml", crate = package["name"], module = "dbx_tools." + binding.replace("-", "_") + "_rs", visibility = ["PUBLIC"])
