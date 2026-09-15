"""Generate deterministic Markdown API reference pages from Python source ASTs."""

from __future__ import annotations

import argparse
import ast
import textwrap
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Member:
    """One public function, class, constant, or type alias in a Python module."""

    name: str
    kind: str
    module: str
    source: Path
    line: int
    signature: str
    docstring: str | None
    alias_of: str | None = None
    fields: tuple[tuple[str, str], ...] = ()
    methods: tuple[Member, ...] = ()


@dataclass
class Module:
    """Parsed public surface and import relationships for one Python module."""

    name: str
    source: Path
    docstring: str | None
    members: dict[str, Member] = field(default_factory=dict)
    imports: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    exports: list[str] | None = None


def project_metadata(package_dir: Path) -> tuple[str, str, Path]:
    """Return distribution name, import module, and package source directory."""

    data = tomllib.loads((package_dir / "pyproject.toml").read_text())
    distribution = data["project"]["name"]
    backend = data["tool"]["uv"]["build-backend"]
    module_name = backend["module-name"]
    module_root = package_dir / backend.get("module-root", "src")
    module_dir = module_root.joinpath(*module_name.split("."))
    return distribution, module_name, module_dir


def normalized_docstring(value: str | None) -> str | None:
    """Normalize indentation while retaining paragraph and field structure."""

    if value is None:
        return None
    normalized = textwrap.dedent(value).strip()
    return normalized or None


def static_string_list(node: ast.AST | None) -> list[str] | None:
    """Read a literal list or tuple of strings without executing package code."""

    if not isinstance(node, (ast.List, ast.Tuple)):
        return None
    values: list[str] = []
    for item in node.elts:
        if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
            return None
        values.append(item.value)
    return values


def assigned_names(node: ast.Assign | ast.AnnAssign) -> list[str]:
    """Return simple top-level names assigned by a statement."""

    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    return [target.id for target in targets if isinstance(target, ast.Name)]


def assignment_docstring(body: list[ast.stmt], index: int) -> str | None:
    """Read a PEP 258 attribute docstring immediately following an assignment."""

    if index + 1 >= len(body):
        return None
    candidate = body[index + 1]
    if (
        isinstance(candidate, ast.Expr)
        and isinstance(candidate.value, ast.Constant)
        and isinstance(candidate.value.value, str)
    ):
        return normalized_docstring(candidate.value.value)
    return None


def function_signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Render a stable function signature from syntax nodes only."""

    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    returns = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
    return f"{prefix} {node.name}({ast.unparse(node.args)}){returns}"


def class_signature(node: ast.ClassDef) -> str:
    """Render a class declaration without its implementation body."""

    arguments = [ast.unparse(base) for base in node.bases]
    arguments.extend(f"{keyword.arg}={ast.unparse(keyword.value)}" for keyword in node.keywords)
    suffix = f"({', '.join(arguments)})" if arguments else ""
    return f"class {node.name}{suffix}"


def class_fields(node: ast.ClassDef) -> tuple[tuple[str, str], ...]:
    """Return annotated public class and dataclass fields."""

    fields = []
    for statement in node.body:
        if not isinstance(statement, ast.AnnAssign) or not isinstance(statement.target, ast.Name):
            continue
        if statement.target.id.startswith("_"):
            continue
        fields.append((statement.target.id, ast.unparse(statement.annotation)))
    return tuple(fields)


def class_methods(node: ast.ClassDef, module: str, source: Path) -> tuple[Member, ...]:
    """Return public methods declared directly on a class."""

    methods = []
    for statement in node.body:
        if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if statement.name.startswith("_"):
            continue
        methods.append(
            Member(
                name=statement.name,
                kind="method",
                module=module,
                source=source,
                line=statement.lineno,
                signature=function_signature(statement),
                docstring=normalized_docstring(ast.get_docstring(statement, clean=False)),
            )
        )
    return tuple(methods)


def relative_import(current: str, level: int, imported: str | None, *, is_package: bool) -> str:
    """Resolve an ImportFrom module name within the current package."""

    parts = current.split(".")
    package_parts = parts if is_package else parts[:-1]
    if level:
        package_parts = package_parts[: len(package_parts) - level + 1]
    if imported:
        package_parts.extend(imported.split("."))
    return ".".join(package_parts)


def module_name(module_root: str, module_dir: Path, source: Path) -> str:
    """Map a source path to its fully qualified import name."""

    relative = source.relative_to(module_dir)
    parts = list(relative.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join([module_root, *parts]) if parts else module_root


def parse_module(module_root: str, module_dir: Path, source: Path) -> Module:
    """Parse one source file into its public declarations and import graph."""

    text = source.read_text()
    tree = ast.parse(text, filename=str(source))
    name = module_name(module_root, module_dir, source)
    parsed = Module(
        name=name,
        source=source,
        docstring=normalized_docstring(ast.get_docstring(tree, clean=False)),
    )
    for index, statement in enumerate(tree.body):
        if isinstance(statement, ast.ImportFrom):
            imported_module = relative_import(
                name,
                statement.level,
                statement.module,
                is_package=source.name == "__init__.py",
            )
            for alias in statement.names:
                local_name = alias.asname or alias.name
                if alias.name == "*":
                    continue
                if statement.module is None:
                    parsed.imports[local_name] = (f"{imported_module}.{alias.name}", None)
                else:
                    parsed.imports[local_name] = (imported_module, alias.name)
            continue
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                parsed.imports[alias.asname or alias.name.split(".")[0]] = (alias.name, None)
            continue
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if statement.name.startswith("_"):
                continue
            parsed.members[statement.name] = Member(
                name=statement.name,
                kind="function",
                module=name,
                source=source,
                line=statement.lineno,
                signature=function_signature(statement),
                docstring=normalized_docstring(ast.get_docstring(statement, clean=False)),
            )
            continue
        if isinstance(statement, ast.ClassDef):
            if statement.name.startswith("_"):
                continue
            parsed.members[statement.name] = Member(
                name=statement.name,
                kind="class",
                module=name,
                source=source,
                line=statement.lineno,
                signature=class_signature(statement),
                docstring=normalized_docstring(ast.get_docstring(statement, clean=False)),
                fields=class_fields(statement),
                methods=class_methods(statement, name, source),
            )
            continue
        if not isinstance(statement, (ast.Assign, ast.AnnAssign)):
            continue
        names = assigned_names(statement)
        value = statement.value
        if "__all__" in names:
            parsed.exports = static_string_list(value)
            continue
        for assigned in names:
            if assigned.startswith("_"):
                continue
            alias_of = value.id if isinstance(value, ast.Name) else None
            annotation = statement.annotation if isinstance(statement, ast.AnnAssign) else None
            kind = (
                "type alias"
                if annotation and ast.unparse(annotation).endswith("TypeAlias")
                else "data"
            )
            signature = assigned
            if annotation is not None:
                signature = f"{assigned}: {ast.unparse(annotation)}"
            parsed.members[assigned] = Member(
                name=assigned,
                kind=kind,
                module=name,
                source=source,
                line=statement.lineno,
                signature=signature,
                docstring=assignment_docstring(tree.body, index),
                alias_of=alias_of,
            )
    return parsed


def resolve_member(
    modules: dict[str, Module],
    module_name_value: str,
    name: str,
    seen: set[tuple[str, str]] | None = None,
) -> tuple[Member | None, str | None]:
    """Resolve a re-export or compatibility alias to its owning definition."""

    seen = seen or set()
    key = (module_name_value, name)
    if key in seen:
        return None, None
    seen.add(key)
    module = modules.get(module_name_value)
    if module is None:
        return None, module_name_value
    member = module.members.get(name)
    if member is not None:
        if member.alias_of:
            resolved, external = resolve_member(modules, module_name_value, member.alias_of, seen)
            if resolved is not None:
                return resolved, external
            if external is not None:
                return None, external
            return member, None
        return member, None
    imported = module.imports.get(name)
    if imported is None:
        return None, module_name_value
    imported_module, imported_name = imported
    if imported_name is None:
        return None, imported_module
    return resolve_member(modules, imported_module, imported_name, seen)


def module_anchor(value: str) -> str:
    """Return Starlight's predictable heading anchor for a module or symbol."""

    return value.lower().replace(".", "")


def render_docstring(value: str | None) -> str:
    """Render source prose or an explicit absence marker."""

    return value or "No source docstring is available."


def render_member(member: Member, repo_root: Path) -> list[str]:
    """Render one owning definition and its public class members."""

    source = member.source.relative_to(repo_root).as_posix()
    lines = [f"### `{member.name}`", "", f"```python\n{member.signature}\n```", ""]
    lines.extend([render_docstring(member.docstring), "", f"Source: `{source}:{member.line}`", ""])
    if member.fields:
        lines.extend(["#### Fields", ""])
        lines.extend(f"- `{name}: {annotation}`" for name, annotation in member.fields)
        lines.append("")
    if member.methods:
        lines.extend(["#### Methods", ""])
        for method in member.methods:
            lines.extend(
                [
                    f"##### `{method.name}`",
                    "",
                    f"```python\n{method.signature}\n```",
                    "",
                    render_docstring(method.docstring),
                    "",
                    f"Source: `{source}:{method.line}`",
                    "",
                ]
            )
    return lines


def render_package(package_dir: Path, output: Path, repo_root: Path) -> dict[str, int | str]:
    """Generate one package API page and return summary counts."""

    distribution, root_module, module_dir = project_metadata(package_dir)
    modules = {
        parsed.name: parsed
        for source in sorted(module_dir.rglob("*.py"))
        if "__pycache__" not in source.parts
        for parsed in [parse_module(root_module, module_dir, source)]
    }
    root = modules.get(root_module)
    public_exports = root.exports if root and root.exports is not None else None

    selected: dict[tuple[str, str], Member] = {}
    export_rows = []
    if public_exports is not None:
        for export in public_exports:
            member, external = resolve_member(modules, root_module, export)
            if member is not None:
                selected[(member.module, member.name)] = member
                detail = (
                    f"Alias of [`{member.name}`](#{module_anchor(member.name)})"
                    if export != member.name
                    else member.kind
                )
                export_rows.append((export, member.module, detail))
            else:
                export_rows.append(
                    (export, external or root_module, "module or external re-export")
                )
    else:
        for module in modules.values():
            for member in module.members.values():
                if member.alias_of:
                    continue
                selected[(member.module, member.name)] = member

    source_path = package_dir.relative_to(repo_root).as_posix()
    lines = [
        "---",
        f'title: "{distribution} Python API"',
        f'description: "Generated Python API reference for {distribution}."',
        f'source: "{source_path}"',
        "editUrl: false",
        "---",
        "",
        "<!--",
        "  Generated by docs/scripts/generate_python_api.py.",
        "  Do not edit generated files under .docs-build/.",
        "-->",
        "",
        f"Import package: `{root_module}`.",
        "",
    ]
    if export_rows:
        lines.extend(
            [
                "## Public Exports",
                "",
                "| Export | Owner | Kind |",
                "| --- | --- | --- |",
                *[f"| `{name}` | `{owner}` | {detail} |" for name, owner, detail in export_rows],
                "",
            ]
        )

    by_module: dict[str, list[Member]] = {}
    for member in selected.values():
        by_module.setdefault(member.module, []).append(member)
    for name in sorted(by_module):
        module = modules[name]
        lines.extend([f"## `{name}`", ""])
        if module.docstring:
            lines.extend([module.docstring, ""])
        for member in sorted(
            by_module[name], key=lambda candidate: (candidate.line, candidate.name)
        ):
            lines.extend(render_member(member, repo_root))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines).rstrip() + "\n")
    return {
        "distribution": distribution,
        "modules": len(by_module),
        "members": len(selected),
    }


def main() -> None:
    """Parse command-line arguments and generate one API page."""

    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repo-root", default=Path.cwd(), type=Path)
    args = parser.parse_args()
    result = render_package(args.package.resolve(), args.output.resolve(), args.repo_root.resolve())
    print(
        f"Generated Python API docs for {result['distribution']} "
        f"({result['members']} definitions across {result['modules']} modules)"
    )


if __name__ == "__main__":
    main()
