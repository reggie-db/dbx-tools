load("@crates//:defs.bzl", "aliases", "all_crate_deps", "crate_edition")
load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_library", "rust_shared_library", "rust_test")
load(":uniffi.bzl", "dbx_uniffi")

def dbx_rust_library(crate_name, deps = [], uniffi = False, node_package = "", python_module = "", tests = True):
    common = dict(
        srcs = native.glob(["src/**/*.rs"]),
        crate_name = crate_name,
        crate_root = "src/lib.rs",
        edition = crate_edition(),
        aliases = aliases(),
        deps = deps + all_crate_deps(normal = True),
        proc_macro_deps = all_crate_deps(proc_macro = True),
        compile_data = ["Cargo.toml", "//:Cargo.toml"] + native.glob(["assets/**"], allow_empty = True),
        version = "0.0.0-bazel",
        visibility = ["//visibility:public"],
    )
    rust_library(name = "lib", **common)
    if tests:
        rust_test(
            name = "unit_tests",
            crate = ":lib",
            deps = deps + all_crate_deps(normal_dev = True),
            proc_macro_deps = all_crate_deps(proc_macro_dev = True),
        )
        for source in native.glob(["tests/*.rs"], allow_empty = True):
            rust_test(
                name = source.removeprefix("tests/").removesuffix(".rs") + "_tests",
                srcs = [source],
                crate_root = source,
                edition = crate_edition(),
                deps = [":lib"] + deps + all_crate_deps(normal = True, normal_dev = True),
                proc_macro_deps = all_crate_deps(proc_macro = True, proc_macro_dev = True),
                data = native.glob(["assets/**", "tests/fixtures/**"], allow_empty = True),
            )
    if uniffi:
        rust_shared_library(name = "native", **common)
        rust_binary(
            name = "bindgen",
            srcs = ["uniffi-bindgen.rs"],
            edition = crate_edition(),
            deps = all_crate_deps(normal = True),
            proc_macro_deps = all_crate_deps(proc_macro = True),
        )
        dbx_uniffi(
            name = "bindings",
            crate_name = crate_name,
            node_package = node_package,
            python_module = python_module,
            config = "uniffi.toml",
            library = ":native",
            generator = ":bindgen",
            deps = [dependency.removesuffix(":lib") + ":bindings" for dependency in deps],
            tags = ["manual"],
            visibility = ["//visibility:public"],
        )

def dbx_rust_binary(crate_name, deps = [], **kwargs):
    rust_binary(
        name = "bin",
        crate_name = crate_name,
        crate_root = "src/main.rs",
        srcs = native.glob(["src/**/*.rs"]),
        edition = crate_edition(),
        aliases = aliases(),
        deps = deps + all_crate_deps(normal = True),
        proc_macro_deps = all_crate_deps(proc_macro = True),
        version = "0.0.0-bazel",
        visibility = ["//visibility:public"],
        compile_data = ["Cargo.toml", "//:Cargo.toml"],
        **kwargs
    )
    rust_test(
        name = "unit_tests",
        crate = ":bin",
        deps = deps + all_crate_deps(normal_dev = True),
        proc_macro_deps = all_crate_deps(proc_macro_dev = True),
        **kwargs
    )
