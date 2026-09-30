load(":bun_npm.bzl", "BunPackages")

TypeScriptPackage = provider(fields = ["directory", "package", "closure"])

def _package_closure(deps):
    closure = {}
    for dep in deps:
        package = dep[TypeScriptPackage]
        closure.update(package.closure)
        closure[package.package] = package.directory
    return closure

def _typescript_impl(ctx):
    source = ctx.attrs.source_dir
    if source == None:
        source = ctx.actions.symlinked_dir("sources", {file.short_path: file for file in ctx.attrs.srcs})
    output = ctx.actions.declare_output("lib", dir = True)
    metadata = ctx.actions.write_json("package-metadata.json", {
        "package": ctx.attrs.package,
        "version": ctx.attrs.version,
        "kind": ctx.attrs.kind,
        "exports": ctx.attrs.exports,
    })
    tools = ctx.attrs._tooling[BunPackages].directory
    runtime = ctx.attrs.runtime[BunPackages].directory
    command = cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._compiler.project("compile.ts"), source, output.as_output(), metadata, tools, runtime)
    closure = _package_closure(ctx.attrs.deps)
    for package, directory in closure.items():
        command.add(package, directory)
    ctx.actions.run(command, category = "typescript", identifier = ctx.label.name, local_only = True)
    return [DefaultInfo(default_output = output), TypeScriptPackage(directory = output, package = ctx.attrs.package, closure = closure)]

_typescript = rule(
    impl = _typescript_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "source_dir": attrs.option(attrs.source(), default = None),
        "package": attrs.string(),
        "version": attrs.string(default = "0.0.0"),
        "kind": attrs.string(default = "node"),
        "exports": attrs.dict(attrs.string(), attrs.string()),
        "deps": attrs.list(attrs.dep(providers = [TypeScriptPackage]), default = []),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_tooling": attrs.dep(default = "root//third_party/js:tooling"),
        "runtime": attrs.dep(default = "root//third_party/js:runtime"),
        "_compiler": attrs.source(default = "root//tools/build:scripts"),
    },
)

def _typescript_test_impl(ctx):
    source = ctx.actions.symlinked_dir("test-sources", {file.short_path: file for file in ctx.attrs.srcs})
    output = ctx.actions.declare_output("test-runtime", dir = True)
    metadata = ctx.actions.write_json("test-metadata.json", {
        "package": ctx.attrs.package[TypeScriptPackage].package,
        "version": ctx.attrs.version,
    })
    tooling = ctx.attrs._tooling[BunPackages]
    runtime = ctx.attrs.runtime[BunPackages]
    python = [path for path in [ctx.attrs.python_runtime, ctx.attrs.python_core, ctx.attrs.python_core_rs, ctx.attrs.python_postgres] if path != None]
    command = cmd_args(
        ctx.attrs._bun[RunInfo],
        ctx.attrs._scripts.project("test-package.ts"),
        source,
        output.as_output(),
        metadata,
        tooling.directory,
        runtime.directory,
        str(len(python)),
        python,
    )
    closure = _package_closure([ctx.attrs.package] + ctx.attrs.deps)
    for package, directory in closure.items():
        command.add(package, directory)
    ctx.actions.run(command, category = "typescript_test", identifier = ctx.label.name, local_only = True)
    env = {"POLYGLOT_REPOSITORY_ROOT": "."}
    if python:
        env["PYTHONPATH"] = output.project("python")
    return [
        DefaultInfo(default_output = output),
        ExternalRunnerTestInfo(
            type = "custom",
            command = [cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._scripts.project("run-tests.ts"), ctx.attrs._uv[RunInfo], ctx.attrs._tools_lock, output.project("test"))],
            env = env,
        ),
    ]

_typescript_test = rule(
    impl = _typescript_test_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "package": attrs.dep(providers = [TypeScriptPackage]),
        "version": attrs.string(),
        "deps": attrs.list(attrs.dep(providers = [TypeScriptPackage]), default = []),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_uv": attrs.exec_dep(default = "host_tools//:uv"),
        "_tooling": attrs.dep(default = "root//third_party/js:tooling"),
        "python_runtime": attrs.option(attrs.source(), default = None),
        "python_core": attrs.option(attrs.source(), default = None),
        "python_core_rs": attrs.option(attrs.source(), default = None),
        "python_postgres": attrs.option(attrs.source(), default = None),
        "runtime": attrs.dep(default = "root//third_party/js:runtime"),
        "_scripts": attrs.source(default = "root//tools/build:scripts"),
        "_tools_lock": attrs.source(default = "root//tools/build:tools.lock.json"),
    },
)

def _vite_impl(ctx):
    output = ctx.actions.declare_output("dist", dir = True)
    ctx.actions.run(cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._script, ctx.attrs.library[TypeScriptPackage].directory, output.as_output(), ctx.attrs._tooling[BunPackages].directory), category = "vite", local_only = True)
    return [DefaultInfo(default_output = output)]

_vite = rule(
    impl = _vite_impl,
    attrs = {
        "library": attrs.dep(providers = [TypeScriptPackage]),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_tooling": attrs.dep(default = "root//third_party/js:tooling"),
        "_script": attrs.source(default = "root//tools/build:vite.ts"),
    },
)

def dbx_typescript(name, package, version = "0.0.0", exports = None, deps = [], kind = "node", runtime = "root//third_party/js:runtime", source_dir = None, polyglot = False):
    _typescript(
        name = name,
        package = package,
        version = version,
        kind = kind,
        exports = exports or {".": "./api.ts"},
        srcs = [] if source_dir else native.glob(["src/**", "bin/**", "exports.ts"], exclude = ["**/BUCK", "**/*.test.*", "**/*.spec.*"]),
        source_dir = source_dir,
        deps = deps,
        runtime = runtime,
        visibility = ["PUBLIC"],
    )
    tests = native.glob(["test/**/*.ts", "test/**/*.tsx", "test/**/*.js", "test/**/*.jsx"])
    if tests and source_dir == None:
        _typescript_test(
            name = "test",
            srcs = native.glob(["src/**", "test/**", "bin/**", "exports.ts"], exclude = ["**/BUCK"]),
            package = ":" + name,
            version = version,
            deps = ["//packages/test/polyglot:package"],
            python_runtime = "//third_party/python:runtime" if polyglot else None,
            python_core = "//packages/py/core:package_sources" if polyglot else None,
            python_core_rs = "//packages/rs/core:bindings[python]" if polyglot else None,
            python_postgres = "//packages/py/postgres:package_sources" if polyglot else None,
        )

def dbx_ui(name, package, version = "0.0.0", exports = None, deps = [], runtime = "root//third_party/js:runtime", polyglot = False):
    dbx_typescript(name = name, package = package, version = version, exports = exports, deps = deps, kind = "ui", runtime = runtime, polyglot = polyglot)
    _vite(name = "bundle", library = ":" + name, visibility = ["PUBLIC"])
