import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "src/shared_core/string.py"
SPEC = importlib.util.spec_from_file_location("shared_core_string", MODULE_PATH)
assert SPEC and SPEC.loader
string = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(string)


class StringParityTest(unittest.TestCase):
    def test_tokenize_matches_typescript_overrides(self) -> None:
        self.assertEqual(
            list(
                string.tokenize_with_options(
                    {"lowerCase": True, "capitalize": True},
                    "local-fs ai-tools v2Endpoint",
                )
            ),
            ["Local", "FS", "AI", "Tools", "V2", "Endpoint"],
        )

    def test_identifiers_and_hash_suffixes_match_typescript(self) -> None:
        self.assertEqual(string.to_slug("HelloWorld v2"), "hello-world-v2")
        self.assertEqual(
            string.to_identifier_with_options({"maxLength": 6}, "Supercalifragilistic"),
            "07d6sy",
        )
        self.assertEqual(
            string.to_identifier_with_options(
                {"max_length": 12}, "hello Supercalifragilistic"
            ),
            "hello-1e06cs",
        )
        self.assertEqual(string.to_unique_slug("Hello, world!"), "hello_world_33ngms")

    def test_string_normalization_matches_typescript(self) -> None:
        self.assertEqual(string.trim_to_null("  hi  "), "hi")
        self.assertIsNone(string.trim_to_null(42))
        self.assertEqual(string.trim_to_empty(None), "")
        self.assertEqual(string.first_non_empty(["", " second "]), "second")
        self.assertEqual(string.parse_list("a, b  c,d,a"), ["a", "b", "c", "d"])
        self.assertEqual(string.escape_html('<&>"\''), "&lt;&amp;&gt;&quot;&#39;")

    def test_description_and_label_match_typescript(self) -> None:
        description = [
            "Lead",
            {"bullets": ["One", {"Nested": {"numbered": ["A", "B"]}}]},
            "Tail",
        ]
        self.assertEqual(
            string.to_description(description),
            "Lead\n- One\n- Nested:\n\n  1. A\n  2. B\nTail",
        )
        self.assertEqual(string.to_label("local-fs_v2Endpoint"), "Local FS V2 Endpoint")
        self.assertEqual(string.pluralize(1, "barrel"), "1 barrel")
        self.assertEqual(string.pluralize(2, "barrel"), "2 barrels")


if __name__ == "__main__":
    unittest.main()
