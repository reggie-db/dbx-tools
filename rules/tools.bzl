def _executable_impl(ctx):
    return [DefaultInfo(default_output = ctx.attrs.binary), RunInfo(args = cmd_args(ctx.attrs.binary))]

executable = rule(
    impl = _executable_impl,
    attrs = {"binary": attrs.source()},
)
