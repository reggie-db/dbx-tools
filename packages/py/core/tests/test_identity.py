from __future__ import annotations

import pytest
from dbx_tools.core import fnv_hash, to_identifier, to_stable_key


def test_fnv_hash_matches_node_string_hashes() -> None:
    assert fnv_hash("string:7:billing") == "1m8m64"
    assert fnv_hash("string:7:billing\0string:4:prod") == "091p2g"
    assert fnv_hash("string:7:billing", length=7) == "1m8m64b"
    with pytest.raises(ValueError):
        fnv_hash("billing", length=0)


def test_stable_key_preserves_types_structure_and_object_order_independence() -> None:
    assert to_stable_key(1) != to_stable_key("1")
    assert to_stable_key(["a", "bc"]) != to_stable_key(["ab", "c"])
    assert to_stable_key({"a": 1, "b": 2}) == to_stable_key({"b": 2, "a": 1})
    with pytest.raises(TypeError):
        to_stable_key(float("inf"))


def test_identifier_matches_the_bus_readable_prefix() -> None:
    assert to_identifier("billing", "Prod") == "billing_prod"
    assert to_identifier("myApp") == "my_app"
    assert to_identifier("my-app") == to_identifier("my_app")
