"""Reject undocumented public declarations in handwritten Python modules."""

from __future__ import annotations

import ast
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Finding:
    """One undocumented module, class, function, or public class method."""

    source: Path
    line: int
    name: str


def module_description(module: ast.Module) -> str | None:
    """Return a conventional docstring or the description immediately after imports."""

    description = ast.get_docstring(module)
    if description is not None:
        return description
    for statement in module.body:
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            continue
        if (
            isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Constant)
            and isinstance(statement.value.value, str)
        ):
            return statement.value.value
        return None
    return None


def is_vendored(source: Path, root: Path) -> bool:
    """Return whether an ancestor marks this source as an upstream snapshot."""

    parent = source.parent
    while parent != root and parent != parent.parent:
        if (parent / "LICENSE.upstream").is_file():
            return True
        parent = parent.parent
    return False


def collect_undocumented(root: Path) -> list[Finding]:
    """Return undocumented handwritten Python declarations under package sources."""

    findings: list[Finding] = []
    for source in sorted((root / "packages" / "py").glob("*/src/**/*.py")):
        if any(
            part in {"generated", "_generated", "__pycache__"}
            for part in source.parts
        ) or is_vendored(source, root):
            continue
        module = ast.parse(source.read_text(), filename=str(source))
        if source.name != "__init__.py" and module_description(module) is None:
            findings.append(Finding(source, 1, "<module>"))
        for declaration in module.body:
            if not isinstance(declaration, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if declaration.name.startswith("_"):
                continue
            if ast.get_docstring(declaration) is None:
                findings.append(Finding(source, declaration.lineno, declaration.name))
            if isinstance(declaration, ast.ClassDef):
                for member in declaration.body:
                    if not isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    if member.name.startswith("_") or ast.get_docstring(member) is not None:
                        continue
                    findings.append(
                        Finding(source, member.lineno, f"{declaration.name}.{member.name}")
                    )
    return findings


def main() -> None:
    """Validate the repository and exit nonzero when documentation is missing."""

    root = Path.cwd()
    findings = collect_undocumented(root)
    if findings:
        print("Undocumented public Python declarations:", file=sys.stderr)
        for finding in findings:
            source = finding.source.relative_to(root).as_posix()
            print(f"  {finding.name} ({source}:{finding.line})", file=sys.stderr)
        raise SystemExit(1)
    print("Validated handwritten public Python declarations; no documentation debt remains.")


if __name__ == "__main__":
    main()
