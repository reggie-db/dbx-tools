import tempfile
import unittest
from pathlib import Path

from generate_python_api import render_package


class GeneratePythonApiTest(unittest.TestCase):
    def package(self, root: Path, init: str, modules: dict[str, str]) -> Path:
        package = root / "packages" / "py" / "example"
        module = package / "src" / "example"
        module.mkdir(parents=True)
        (package / "pyproject.toml").write_text(
            """
[project]
name = "example-package"

[tool.uv.build-backend]
module-name = "example"
module-root = "src"
""".strip()
            + "\n"
        )
        (module / "__init__.py").write_text(init.lstrip())
        for name, source in modules.items():
            (module / name).write_text(source.lstrip())
        return package

    def test_renders_alias_once_and_includes_public_methods(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = self.package(
                root,
                """
from .client import Client, create_client

createClient = create_client
__all__ = ["Client", "create_client", "createClient"]
""",
                {
                    "client.py": '''class Client:
    """Own a reusable client connection."""

    async def close(self) -> None:
        """Close the owned connection."""


def create_client() -> Client:
    """Create a client."""
    return Client()
''',
                },
            )
            output = root / "out" / "index.md"

            result = render_package(package, output, root)
            markdown = output.read_text()

            self.assertEqual(result["members"], 2)
            self.assertIn("Alias of [`create_client`](#create_client)", markdown)
            self.assertEqual(markdown.count("### `create_client`"), 1)
            self.assertIn("##### `close`", markdown)
            self.assertIn("Close the owned connection.", markdown)

    def test_renders_implicit_public_surface_without_alias_assignments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = self.package(
                root,
                """
from .values import ALIAS, VALUE, create_value
""",
                {
                    "values.py": '''
VALUE: int = 1
"""Primary value."""
ALIAS = VALUE
_PRIVATE = 2

def create_value() -> int:
    """Return the value."""
    return VALUE
''',
                },
            )
            output = root / "out" / "index.md"

            result = render_package(package, output, root)
            markdown = output.read_text()

            self.assertEqual(result["members"], 2)
            self.assertIn("### `VALUE`", markdown)
            self.assertIn("Primary value.", markdown)
            self.assertIn("### `create_value`", markdown)
            self.assertNotIn("### `ALIAS`", markdown)
            self.assertNotIn("_PRIVATE", markdown)

    def test_lists_external_reexports_without_fabricating_definitions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = self.package(
                root,
                """
from external_package import RemoteClient

__all__ = ["RemoteClient"]
""",
                {},
            )
            output = root / "out" / "index.md"

            result = render_package(package, output, root)
            markdown = output.read_text()

            self.assertEqual(result["members"], 0)
            self.assertIn(
                "| `RemoteClient` | `external_package` | module or external re-export |",
                markdown,
            )
            self.assertNotIn("### `RemoteClient`", markdown)


if __name__ == "__main__":
    unittest.main()
