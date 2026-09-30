import unittest

from packaging.version import Version
from dbx_tools.core.string import to_identifier


class CoreTest(unittest.TestCase):
    def test_dependency_and_library_imports(self):
        self.assertLess(Version("1.2.0"), Version("1.3.0"))
        self.assertIsInstance(to_identifier("A Sample Name"), str)


if __name__ == "__main__":
    unittest.main()
