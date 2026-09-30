def _cargo_config_impl(repository_ctx):
    source = repository_ctx.getenv("DBX_CARGO_CONFIG")
    if not source:
        cargo_home = repository_ctx.getenv("CARGO_HOME")
        home = repository_ctx.getenv("HOME")
        if cargo_home:
            source = cargo_home + "/config.toml"
        elif home:
            source = home + "/.cargo/config.toml"
    path = repository_ctx.path(source) if source else None
    content = repository_ctx.read(path) if path and path.exists else ""
    repository_ctx.file("config.toml", content)
    repository_ctx.file("BUILD.bazel", "exports_files([\"config.toml\"])\n")

cargo_config = repository_rule(
    implementation = _cargo_config_impl,
    configure = True,
    local = True,
    environ = ["CARGO_HOME", "DBX_CARGO_CONFIG", "HOME"],
)

def _host_bun_repository_impl(repository_ctx):
    bun = repository_ctx.getenv("DBX_BUN_EXECUTABLE") or repository_ctx.which("bun")
    if not bun:
        fail("Bun is required to run JavaScript tests")
    workspace = repository_ctx.path(repository_ctx.attr.workspace_marker).dirname
    repository_ctx.file(
        "bun-workspace",
        """#!/bin/sh
set -eu
cd "%s"
if [ -x ".venv/bin/python" ]; then
    export POLYGLOT_PYTHON_CONFIG="$(".venv/bin/python" tools/bazel/python-config.py)"
fi
exec "%s" "$@"
""" % (workspace, bun),
        executable = True,
    )
    repository_ctx.file(
        "BUILD.bazel",
        """exports_files(
    ["bun-workspace"],
    visibility = ["//visibility:public"],
)
""",
    )

host_bun_repository = repository_rule(
    implementation = _host_bun_repository_impl,
    attrs = {
        "workspace_marker": attr.label(allow_single_file = True, mandatory = True),
    },
    configure = True,
    local = True,
    environ = ["DBX_BUN_EXECUTABLE", "PATH"],
)

def _uv_repository_impl(repository_ctx):
    uv = repository_ctx.which("uv")
    if not uv:
        fail("uv is required to resolve Python dependencies")
    site_packages = repository_ctx.path("site-packages")
    requirements = repository_ctx.path(repository_ctx.attr.requirements)
    repository_ctx.read(requirements)
    args = [
        uv,
        "pip",
        "install",
        "--requirement",
        requirements,
        "--target",
        site_packages,
        "--python",
        repository_ctx.attr.python_version,
    ]
    result = repository_ctx.execute(
        args + ["--offline"],
        quiet = False,
    )
    if result.return_code:
        result = repository_ctx.execute(
            args,
            environment = {"UV_HTTP_TIMEOUT": "120"},
            quiet = False,
            timeout = 900,
        )
    if result.return_code:
        fail("uv dependency installation failed:\n%s\n%s" % (result.stdout, result.stderr))
    repository_ctx.file(
        "BUILD.bazel",
        """load("@rules_python//python:defs.bzl", "py_library")

py_library(
    name = "site_packages",
    srcs = glob(
        ["site-packages/**/*.py"],
        allow_empty = True,
    ),
    data = glob(
        ["site-packages/**"],
        exclude = [
            "site-packages/**/*.py",
            "site-packages/**/__pycache__/**",
        ],
        allow_empty = True,
    ),
    imports = ["site-packages"],
    visibility = ["//visibility:public"],
)
""",
    )

uv_repository = repository_rule(
    implementation = _uv_repository_impl,
    attrs = {
        "python_version": attr.string(mandatory = True),
        "requirements": attr.label(allow_single_file = True, mandatory = True),
    },
    configure = True,
    local = True,
)
