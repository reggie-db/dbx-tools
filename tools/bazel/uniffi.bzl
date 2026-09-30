load("@aspect_rules_js//js:libs.bzl", "js_binary_lib")

DbxUniFFIInfo = provider(fields = ["configs", "node_packages"])

def _bindings_impl(ctx):
    toolchain = ctx.exec_groups["generator"].toolchains["@rules_rust//rust:toolchain_type"]
    output = ctx.actions.declare_directory(ctx.label.name)
    configs = {ctx.attr.crate_name: ctx.file.config.path}
    node_packages = {ctx.attr.crate_name: ctx.attr.node_package}
    config_files = [ctx.file.config]
    for dependency in ctx.attr.deps:
        configs.update(dependency[DbxUniFFIInfo].configs)
        node_packages.update(dependency[DbxUniFFIInfo].node_packages)
        config_files.extend(dependency[OutputGroupInfo].configs.to_list())
    args = ctx.actions.args()
    args.add_all([
        "--output", output.path,
        "--library", ctx.file.library.path,
        "--ubrn", ctx.executable._ubrn.path,
        "--python-generator", ctx.executable.generator.path,
        "--cargo", toolchain.cargo.path,
        "--rustc", toolchain.rustc.path,
        "--crate", ctx.attr.crate_name,
        "--node-package", ctx.attr.node_package,
        "--python-module", ctx.attr.python_module,
        "--configs", json.encode(configs),
        "--node-packages", json.encode(node_packages),
    ])
    js_binary_lib.run_binary_action(
        ctx,
        executable = ctx.executable._driver,
        arguments = [args],
        inputs = depset([ctx.file.library] + config_files),
        tools = [ctx.attr._driver[DefaultInfo].files_to_run, ctx.attr._ubrn[DefaultInfo].files_to_run, ctx.attr.generator[DefaultInfo].files_to_run] + toolchain.all_files.to_list(),
        outputs = [output],
        mnemonic = "UniFFIBindings",
        progress_message = "Generating bindings for " + ctx.attr.crate_name,
        env = {"JS_BINARY__EXECROOT_ENTRY_POINT": "1"},
    )
    return [
        DefaultInfo(files = depset([output])),
        DbxUniFFIInfo(configs = configs, node_packages = node_packages),
        OutputGroupInfo(configs = depset(config_files)),
    ]

dbx_uniffi = rule(
    implementation = _bindings_impl,
    attrs = {
        "crate_name": attr.string(mandatory = True),
        "node_package": attr.string(mandatory = True),
        "python_module": attr.string(),
        "config": attr.label(allow_single_file = True, mandatory = True),
        "library": attr.label(allow_single_file = True, mandatory = True),
        "generator": attr.label(executable = True, cfg = "exec", mandatory = True),
        "deps": attr.label_list(providers = [DbxUniFFIInfo]),
        "_driver": attr.label(default = "//tools/bazel:uniffi_generator", executable = True, cfg = "exec"),
        "_ubrn": attr.label(default = "@ubrn//:uniffi-bindgen-react-native__uniffi-bindgen-react-native", executable = True, cfg = "exec"),
    },
    exec_groups = {"generator": exec_group(toolchains = ["@rules_rust//rust:toolchain_type"])},
)
