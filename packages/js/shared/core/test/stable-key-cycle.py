from dbx_tools.core import to_stable_key

"""Construct values that cannot cross the Bun/Python FFI boundary."""


def throws_on_cycle() -> None:
    value: dict[str, object] = {}
    value["self"] = value
    to_stable_key(value)
