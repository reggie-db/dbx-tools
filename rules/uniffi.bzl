def _uniffi_impl(ctx):
    output = ctx.actions.declare_output("bindings", dir = True)
    command = cmd_args(ctx.attrs._bun[RunInfo], ctx.attrs._script.project("bindings.ts"), ctx.attrs.library, ctx.attrs.generator[RunInfo], ctx.attrs._ubrn[RunInfo], ctx.attrs.config, ctx.attrs.crate, ctx.attrs.module, output.as_output())
    ctx.actions.run(command, category = "uniffi", local_only = True)
    return [DefaultInfo(default_output = output, sub_targets = {
        "python": [DefaultInfo(default_output = output.project("python"))],
        "typescript": [DefaultInfo(default_output = output.project("typescript"))],
    })]

uniffi_bindings = rule(
    impl = _uniffi_impl,
    attrs = {
        "library": attrs.source(),
        "generator": attrs.exec_dep(providers = [RunInfo]),
        "config": attrs.source(),
        "crate": attrs.string(),
        "module": attrs.string(),
        "_bun": attrs.exec_dep(default = "host_tools//:bun"),
        "_script": attrs.source(default = "root//tools/build:scripts"),
        "_ubrn": attrs.exec_dep(default = "root//tools/build/ubrn:binary", providers = [RunInfo]),
    },
)
