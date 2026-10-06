from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path


def test_pythonmonkey_runs_bundled_cacache(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[4]
    package = tmp_path / "node_modules" / "fixture-cache"
    package.mkdir(parents=True)
    (package / "package.json").write_text(
        '{"name":"fixture-cache","type":"module","exports":"./index.ts"}\n'
    )
    (package / "index.ts").write_text(
        """import cacache from \"cacache\";

export interface CacheRoundTripOptions {
  cacheDir: string;
  key: string;
  value: string;
}

export async function cacheRoundTrip(options: CacheRoundTripOptions): Promise<string> {
  await cacache.put(options.cacheDir, options.key, options.value);
  cacache.clearMemoized();
  const entry = await cacache.get(options.cacheDir, options.key);
  return entry.data.toString(\"utf8\");
}
"""
    )
    (tmp_path / "node_modules" / "cacache").symlink_to(
        root / "node_modules" / "cacache", target_is_directory=True
    )
    project = tmp_path / "python"
    project.mkdir()
    (project / "pyproject.toml").write_text(
        """[tool.uv.build-backend]
module-name = "fixture.runtime"
module-root = "src"

[tool.dbx_tools.node_bindings]
package = "fixture-cache"
"""
    )
    subprocess.run(
        [
            "bun",
            str(root / "projen/tasks/python-node-bindings.ts"),
            "--root",
            str(tmp_path),
            "--project",
            "python",
        ],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    sys.path.insert(0, str(project / "src"))
    try:
        from fixture.runtime._generated.node.fixture_cache.index import cache_round_trip

        cache_dir = tmp_path / "cache"
        value = asyncio.run(
            cache_round_trip(
                {"cacheDir": str(cache_dir), "key": "probe", "value": "durable"}
            )
        )
        assert value == "durable"
    finally:
        sys.path.remove(str(project / "src"))
