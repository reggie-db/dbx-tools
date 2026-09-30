load("@aspect_rules_js//js:defs.bzl", "js_library", "js_run_binary")
load("@aspect_rules_js//npm:defs.bzl", "npm_package")
load("@aspect_rules_ts//ts:defs.bzl", "ts_project")
load("@npm//:defs.bzl", "npm_link_all_packages", "npm_link_targets")
load("@rules_shell//shell:sh_test.bzl", "sh_test")

def _typescript(kind, srcs = None, assets = [], deps = [], root_barrel = True, **kwargs):
    npm_link_all_packages(name = "node_modules")
    package_deps = npm_link_targets(name = "node_modules")
    source_patterns = ["src/**/*.ts", "src/**/*.tsx", "src/**/*.json", "exports.ts", "bin/**/*.ts"]
    if root_barrel:
        source_patterns.append("index.ts")
    sources = srcs if srcs != None else native.glob(
        source_patterns,
        exclude = ["**/*.test.*", "**/*.spec.*"],
        allow_empty = True,
    )
    ts_project(
        name = "compile",
        srcs = sources,
        tsconfig = "tsconfig.json",
        declaration = True,
        resolve_json_module = True,
        transpiler = "tsc",
        out_dir = "lib",
        deps = package_deps + deps,
        validate = True,
        extends = "//tools/bazel:typescript_configs",
        tags = ["dbx-" + kind],
        **kwargs
    )
    js_run_binary(
        name = "manifest",
        tool = "//tools/bazel:package_manifest",
        srcs = ["package.json"],
        outs = ["npm/package.json"],
        args = ["$(location package.json)", "$(location npm/package.json)"],
    )
    npm_package(
        name = "pkg",
        srcs = [":compile", ":manifest"] + native.glob(["src/**/*.css", "src/**/*.svg", "src/**/*.png", "src/**/*.jpg", "src/**/*.json"], allow_empty = True) + assets,
        replace_prefixes = {"npm/": ""},
        visibility = ["//visibility:public"],
    )
    js_library(
        name = "sources",
        srcs = ["package.json"],
        types = sources,
        deps = package_deps + deps,
        visibility = ["//visibility:public"],
    )
    test_sources = native.glob(
        ["test/**/*.test.ts", "test/**/*.test.tsx", "test/**/*.spec.ts", "test/**/*.spec.tsx"],
        allow_empty = True,
    )
    if test_sources:
        test_data = native.glob(["test/**"], allow_empty = True)
        sh_test(
            name = "unit_tests",
            srcs = ["//tools/bazel:bun-test.sh"],
            args = ["$(rootpath @host_bun//:bun-workspace)"] +
                   ["$(rootpath " + source + ")" for source in test_sources],
            data = [
                ":sources",
                "@host_bun//:bun-workspace",
                "//tools/bazel:python-config.py",
            ] + test_data,
            tags = ["exclusive", "local"],
        )

def dbx_shared(**kwargs):
    _typescript(kind = "shared", **kwargs)

def dbx_node(**kwargs):
    _typescript(kind = "node", **kwargs)

def dbx_ui(**kwargs):
    _typescript(kind = "ui", root_barrel = False, **kwargs)

def dbx_app(**kwargs):
    _typescript(kind = "app", **kwargs)
