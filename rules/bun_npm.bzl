BunPackages = provider(fields = ["directory", "packages"])

def _bun_fetch_impl(ctx: AnalysisContext) -> list[Provider]:
    output = ctx.actions.declare_output("npm", dir = True)
    manifest = ctx.actions.write_json("dependencies.json", ctx.attrs.packages)
    command = cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._fetch, "bun", ctx.attrs._bun[RunInfo], output.as_output(), manifest)
    if ctx.attrs.lockfile != None:
        command.add(ctx.attrs.lockfile)
    ctx.actions.run(command, category = "bun_npm", local_only = True)
    return [DefaultInfo(default_output = output), BunPackages(directory = output, packages = ctx.attrs.packages)]

bun_packages = rule(
    impl = _bun_fetch_impl,
    attrs = {
        "packages": attrs.dict(attrs.string(), attrs.string()),
        "lockfile": attrs.option(attrs.source(), default = None),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_fetch": attrs.source(default = "root//rules:fetch.ts"),
    },
)

def bun_package(name, package = None, lockfile = None):
    specifier = package or name
    separator = specifier.rfind("@")
    if separator <= 0:
        fail("Pin the npm package exactly: " + specifier)
    bun_packages(name = name, packages = {specifier[:separator]: specifier[separator + 1:]}, lockfile = lockfile, visibility = ["PUBLIC"])
