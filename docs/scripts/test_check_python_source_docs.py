import tempfile
import unittest
from pathlib import Path

from check_python_source_docs import collect_undocumented


class CheckPythonSourceDocsTest(unittest.TestCase):
    def test_reports_public_declarations_and_skips_generated_modules(self) -> None:
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

            findings = collect_undocumented(root)

            self.assertEqual(
                [(finding.line, finding.name) for finding in findings],
                [(1, "<module>"), (1, "Client"), (2, "Client.close")],
            )


if __name__ == "__main__":
    unittest.main()
