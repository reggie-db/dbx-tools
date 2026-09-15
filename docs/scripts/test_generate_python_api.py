import tempfile
import unittest
from pathlib import Path

from generate_python_api import render_package


class GeneratePythonApiTest(unittest.TestCase):
    def test_renders_alias_once_and_includes_public_methods(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
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
            (module / "__init__.py").write_text(
                """
from .client import Client, create_client

createClient = create_client
__all__ = ["Client", "create_client", "createClient"]
""".lstrip()
            )
            (module / "client.py").write_text(
                '''class Client:
    """Own a reusable client connection."""

    async def close(self) -> None:
        """Close the owned connection."""


def create_client() -> Client:
    """Create a client."""
    return Client()
'''
            )
            output = root / "out" / "index.md"

            result = render_package(package, output, root)
            markdown = output.read_text()

            self.assertEqual(result["members"], 2)
            self.assertIn("Alias of [`create_client`](#create_client)", markdown)
            self.assertEqual(markdown.count("### `create_client`"), 1)
            self.assertIn("##### `close`", markdown)
            self.assertIn("Close the owned connection.", markdown)


if __name__ == "__main__":
    unittest.main()
