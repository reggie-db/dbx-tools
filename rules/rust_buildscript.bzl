load("@prelude//rust:cargo_buildscript.bzl", prelude_buildscript_run = "buildscript_run")

def buildscript_run(name, version, env = {}, **kwargs):
    environment = dict(env)
    environment["DEBUG"] = environment.get("DEBUG", "true")
    environment["OPT_LEVEL"] = environment.get("OPT_LEVEL", "0")
    environment["PROFILE"] = environment.get("PROFILE", "debug")
    release = version.split("+")[0].split("-")[0].split(".")
    for index, field in enumerate(["MAJOR", "MINOR", "PATCH"]):
        environment["CARGO_PKG_VERSION_" + field] = release[index]
    environment["CARGO_PKG_VERSION_PRE"] = version.split("+")[0].partition("-")[2]
    prelude_buildscript_run(name = name, version = version, env = environment, **kwargs)
