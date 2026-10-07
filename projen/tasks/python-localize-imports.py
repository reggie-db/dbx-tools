"""Rewrite absolute imports of synchronized upstream modules to their generated package.

Usage: python-localize-imports.py ROOT TARGET SOURCE [MODULE ...]

ROOT holds the synchronized ``.py`` tree and is importable as the dotted package
TARGET. SOURCE is the dotted path ROOT had upstream (empty when it has none), so
upstream may import a synchronized module either bare (``config.schema``) or under
SOURCE (``graphiti_core.driver.postgraph``). MODULE names the upstream modules to
rewrite; without any, every top-level module in ROOT is rewritten in both forms.

Covers ``import``, ``from ... import``, and constant-string ``__import__`` /
``importlib.import_module`` calls. Prints a JSON object mapping each MODULE to the
number of references rewritten.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

FROM_MODULE = re.compile(r"from\s+([^\W\d]\w*(?:\s*\.\s*[^\W\d]\w*)*)")
DYNAMIC_IMPORTS = {"__import__", "import_module"}


class Localizer:
    def __init__(self, root: Path, target: str, source: str, modules: list[str]) -> None:
        self.target = target
        self.source = source
        local = local_modules(root)
        if modules:
            self.modules = modules
            for module in modules:
                if self.local_name(module).split(".", 1)[0] not in local:
                    raise SystemExit(f"localize_imports module {module!r} is not synchronized")
        else:
            shadowed = sorted(local & set(sys.stdlib_module_names))
            if shadowed:
                raise SystemExit(
                    f"synchronized modules shadow the standard library: {', '.join(shadowed)}; "
                    "list localize_imports modules explicitly"
                )
            self.modules = sorted(local) + (
                [f"{source}.{name}" for name in sorted(local)] if source else []
            )
        # Longest first, so a nested entry owns its imports over its parent.
        self.ordered = sorted(self.modules, key=len, reverse=True)
        self.counts = dict.fromkeys(self.modules, 0)

    def local_name(self, name: str) -> str:
        if self.source and name.startswith(f"{self.source}."):
            return name[len(self.source) + 1 :]
        return name

    def owner(self, name: str) -> str | None:
        return next(
            (module for module in self.ordered if name == module or name.startswith(f"{module}.")),
            None,
        )

    def rewrite(self, name: str) -> str | None:
        module = self.owner(name)
        if module is None:
            return None
        self.counts[module] += 1
        return f"{self.target}.{self.local_name(name)}"

    def localize(self, path: Path) -> None:
        data = path.read_bytes()
        tree = ast.parse(data, filename=str(path))
        starts = [0]
        for line in data.splitlines(keepends=True):
            starts.append(starts[-1] + len(line))

        def span(node: ast.AST) -> tuple[int, int]:
            # AST columns are UTF-8 byte offsets within their line.
            return (
                starts[node.lineno - 1] + node.col_offset,
                starts[node.end_lineno - 1] + node.end_col_offset,
            )

        edits: list[tuple[int, int, bytes]] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level or not node.module:
                    continue
                local = self.rewrite(node.module)
                if local is None:
                    continue
                start, end = span(node)
                text = data[start:end].decode()
                found = FROM_MODULE.match(text)
                if not found or re.sub(r"\s", "", found[1]) != node.module:
                    raise SystemExit(f"{path}:{node.lineno}: cannot locate module in {text!r}")
                edits.append(
                    (
                        start + len(text[: found.start(1)].encode()),
                        start + len(text[: found.end(1)].encode()),
                        local.encode(),
                    )
                )
            elif isinstance(node, ast.Import):
                if not any(self.owner(alias.name) for alias in node.names):
                    continue
                statements = [self.import_statement(path, node, alias) for alias in node.names]
                start, end = span(node)
                edits.append((start, end, "; ".join(statements).encode()))
            elif isinstance(node, ast.Call) and self.is_dynamic_import(node):
                argument = node.args[0]
                local = self.rewrite(argument.value)
                if local is None:
                    continue
                if self.returns_top_level(node):
                    # Without a fromlist, `__import__` returns the top-level package.
                    raise SystemExit(
                        f"{path}:{node.lineno}: pass a fromlist to localize __import__"
                    )
                start, end = span(argument)
                text = data[start:end].decode()
                if argument.value not in text:
                    raise SystemExit(f"{path}:{node.lineno}: cannot rewrite escaped {text!r}")
                edits.append((start, end, text.replace(argument.value, local, 1).encode()))
        if not edits:
            return
        for start, end, replacement in sorted(edits, reverse=True):
            data = data[:start] + replacement + data[end:]
        ast.parse(data, filename=str(path))
        path.write_bytes(data)

    def import_statement(self, path: Path, node: ast.Import, alias: ast.alias) -> str:
        local = self.rewrite(alias.name)
        if local is None:
            return f"import {alias.name}" + (f" as {alias.asname}" if alias.asname else "")
        if alias.asname:
            return f"import {local} as {alias.asname}"
        binding, _, submodule = self.local_name(alias.name).partition(".")
        if binding != alias.name.split(".", 1)[0]:
            # `import pkg.sub` binds `pkg`, which no longer names the synchronized tree.
            raise SystemExit(f"{path}:{node.lineno}: alias `import {alias.name}` to localize it")
        if not submodule:
            return f"from {self.target} import {binding}"
        return f"import {local}; from {self.target} import {binding}"

    @staticmethod
    def is_dynamic_import(node: ast.Call) -> bool:
        function = node.func
        name = function.id if isinstance(function, ast.Name) else getattr(function, "attr", None)
        return (
            name in DYNAMIC_IMPORTS
            and bool(node.args)
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
            and not node.args[0].value.startswith(".")
        )

    @staticmethod
    def returns_top_level(node: ast.Call) -> bool:
        if not isinstance(node.func, ast.Name) or node.func.id != "__import__":
            return False
        return len(node.args) < 4 and not any(
            keyword.arg == "fromlist" for keyword in node.keywords
        )


def local_modules(root: Path) -> set[str]:
    names = set()
    for path in root.rglob("*.py"):
        parts = path.relative_to(root).parts
        name = parts[0] if len(parts) > 1 else path.stem
        if name.isidentifier() and name != "__init__":
            names.add(name)
    return names


def main(argv: list[str]) -> None:
    if len(argv) < 3:
        raise SystemExit(__doc__)
    root, target, source, *modules = argv
    localizer = Localizer(Path(root), target, source, modules)
    for path in sorted(Path(root).rglob("*.py")):
        localizer.localize(path)
    print(json.dumps(localizer.counts))


if __name__ == "__main__":
    main(sys.argv[1:])
