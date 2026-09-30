def dbx_python(name, deps = []):
    native.filegroup(
        name = name + "_sources",
        srcs = {file.removeprefix("src/"): file for file in native.glob(["src/**/*.py"])},
        copy = True,
        visibility = ["PUBLIC"],
    )
    native.python_library(
        name = name,
        srcs = {file.removeprefix("src/"): file for file in native.glob(["src/**/*.py"])},
        base_module = "",
        deps = deps,
        visibility = ["PUBLIC"],
    )
