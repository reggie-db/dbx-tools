def _uv_fetch_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output("site-packages", dir = True)
    requirements = ctx.actions.write_json("requirements.json", ctx.attrs.requirements)
    command = cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._fetch, "uv", ctx.attrs._uv[RunInfo], output.as_output(), requirements)
    if ctx.attrs.lockfile != None:
        command.add(ctx.attrs.lockfile)
    ctx.actions.run(command, category = "uv_pip", local_only = True)
    return [DefaultInfo(default_output = output)]

_uv_fetch = rule(
    impl = _uv_fetch_impl,
    attrs = {
        "requirements": attrs.list(attrs.string()),
        "lockfile": attrs.option(attrs.source(), default = None),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_uv": attrs.exec_dep(default = "host_tools//:uv"),
        "_fetch": attrs.source(default = "root//rules:fetch.ts"),
    },
)

def _uv_lock_impl(ctx):
    output = ctx.actions.declare_output("python.lock")
    requirements = ctx.actions.write_json("requirements.json", ctx.attrs.requirements)
    ctx.actions.run(cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._script, ctx.attrs._uv[RunInfo], requirements, output.as_output()), category = "uv_lock", local_only = True)
    return [DefaultInfo(default_output = output)]

_uv_lock = rule(
    impl = _uv_lock_impl,
    attrs = {
        "requirements": attrs.list(attrs.string()),
        "labels": attrs.list(attrs.string(), default = []),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_uv": attrs.exec_dep(default = "host_tools//:uv"),
        "_script": attrs.source(default = "root//rules:uv_lock.ts"),
    },
)

def uv_package(name, requirement = None, requirements = None, lockfile = None):
    requested = requirements if requirements != None else [requirement or name]
    for item in requested:
        if "==" not in item and " @ " not in item:
            fail("Pin the Python requirement exactly: " + item)
    _uv_fetch(name = name + "_fetch", requirements = requested, lockfile = lockfile)
    _uv_lock(name = name + "_lock", requirements = requested, labels = ["manual"])
    native.prebuilt_python_library(name = name, source_dir = ":" + name + "_fetch", visibility = ["PUBLIC"])
