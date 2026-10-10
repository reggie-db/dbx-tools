import tempfile
import unittest
from pathlib import Path

from check_python_source_docs import collect_undocumented


class CheckPythonSourceDocsTest(unittest.TestCase):
    def test_reports_public_declarations_and_skips_derived_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "packages" / "py" / "example" / "src" / "example"
            source.mkdir(parents=True)
            (source / "client.py").write_text(
                """class Client:\n    def close(self) -> None:\n        pass\n"""
            )
            generated = source / "_generated"
            generated.mkdir()
            (generated / "client.py").write_text("class Generated:\n    pass\n")
            vendored = source / "vendor"
            vendored.mkdir()
            (vendored / "LICENSE.upstream").write_text("Upstream license")
            (vendored / "client.py").write_text("class Vendored:\n    pass\n")

            findings = collect_undocumented(root)

            self.assertEqual(
                [(finding.line, finding.name) for finding in findings],
                [(1, "<module>"), (1, "Client"), (2, "Client.close")],
            )

    def test_accepts_a_module_description_after_imports(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "packages" / "py" / "example" / "src" / "example"
            source.mkdir(parents=True)
            (source / "client.py").write_text(
                "from pathlib import Path\n\n"
                '"""Documented after imports."""\n\n'
                "def load() -> Path:\n"
                '    """Load a path."""\n'
                '    return Path(".")\n'
            )

            self.assertEqual(collect_undocumented(root), [])


if __name__ == "__main__":
    unittest.main()
