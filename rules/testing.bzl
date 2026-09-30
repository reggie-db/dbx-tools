load(":bun_npm.bzl", "BunPackages")

def _bun_test_impl(ctx):
    command = cmd_args(ctx.attrs._bun[RunInfo], "test", ctx.attrs.srcs, hidden = ctx.attrs._support)
    return [
        DefaultInfo(),
        ExternalRunnerTestInfo(type = "custom", command = [command], env = {"DBX_BUILD_MODULES": cmd_args(ctx.attrs._tooling[BunPackages].directory)}),
    ]

bun_test = rule(
    impl = _bun_test_impl,
    attrs = {
        "srcs": attrs.list(attrs.source()),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_tooling": attrs.dep(default = "root//third_party/js:tooling"),
        "_support": attrs.source(default = "root//tools/build:scripts"),
    },
)
