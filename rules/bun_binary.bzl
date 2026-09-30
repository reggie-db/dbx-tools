load(":bun_npm.bzl", "BunPackages")
load(":typescript.bzl", "TypeScriptPackage")

def _bun_binary_impl(ctx):
    files = {"main.ts": ctx.attrs.main}
    npm = ctx.attrs.npm[BunPackages]
    for name in npm.packages:
        files["node_modules/" + name] = npm.directory.project("node_modules/" + name)
    for dep in ctx.attrs.deps:
        package = dep[TypeScriptPackage]
        files["node_modules/" + package.package] = package.directory
        for name, directory in package.closure.items():
            files["node_modules/" + name] = directory
    runtime = ctx.actions.copied_dir("runtime", files)
    return [DefaultInfo(default_output = runtime), RunInfo(args = cmd_args(ctx.attrs._bun[RunInfo], "--preserve-symlinks", runtime.project("main.ts")))]

bun_binary = rule(
    impl = _bun_binary_impl,
    attrs = {
        "main": attrs.source(),
        "deps": attrs.list(attrs.dep(providers = [TypeScriptPackage]), default = []),
        "npm": attrs.dep(default = "root//third_party/js:runtime", providers = [BunPackages]),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
    },
)
