load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("@rules_python//python:defs.bzl", "py_library", "py_test")

def dbx_python(deps = [], tests = False, uniffi_bindings = None, python_module = ""):
    data = []
    imports = ["src"]
    if uniffi_bindings:
        if not python_module:
            fail("python_module is required with uniffi_bindings")
        js_run_binary(
            name = "python_bindings",
            tool = "//tools/bazel:stage_python_bindings",
            srcs = [uniffi_bindings],
            out_dirs = ["generated"],
            args = [
                "$(location " + uniffi_bindings + ")",
                "$(RULEDIR)/generated",
                python_module,
            ],
        )
        data.append(":python_bindings")
        imports = ["generated", "src"]
    py_library(
        name = "lib",
        srcs = [] if uniffi_bindings else native.glob(["src/**/*.py"]),
        data = data,
        imports = imports,
        deps = deps + ["@uv_deps//:site_packages"],
        visibility = ["//visibility:public"],
    )
    if tests:
        test_sources = native.glob(["test/**/*.py", "tests/**/*.py"], allow_empty = True)
        py_test(
            name = "unit_tests",
            main = "//tools/bazel:pytest_main.py",
            srcs = ["//tools/bazel:pytest_main.py"] + test_sources,
            args = ["--asyncio-mode=auto", "--import-mode=importlib"] + ["$(rootpath " + source + ")" for source in test_sources if source.split("/")[-1].startswith("test_")],
            deps = [":lib", "@uv_deps//:site_packages"],
            legacy_create_init = 0,
        )
