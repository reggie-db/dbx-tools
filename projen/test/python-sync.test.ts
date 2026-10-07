import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main } from "../tasks/python-sync.ts";

describe("Python source sync", () => {
  it("uses check-lock-check and writes read-only generated files", async () => {
    const root = mkdtempSync(join(tmpdir(), "python-sync-"));
    const upstream = join(root, "upstream");
    const project = join(root, "project");
    mkdirSync(join(upstream, "driver/tests"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(upstream, "driver/driver.py"), "value = 1\n");
    writeFileSync(join(upstream, "driver/tests/test_driver.py"), "ignored = True\n");
    execFileSync("git", ["init", "--quiet", upstream]);
    execFileSync("git", ["-C", upstream, "add", "."]);
    execFileSync("git", [
      "-C",
      upstream,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const commit = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(project, "pyproject.toml"),
      [
        "[tool.uv.build-backend]",
        'module-name = "fixture.runtime"',
        'module-root = "src"',
        "",
        "[[tool.dbx_tools.sync]]",
        'name = "driver"',
        `source = "fixture @ git+${upstream}@${commit}#subdirectory=driver"`,
        'include = ["**/*.py"]',
        'exclude = ["tests/**"]',
        "",
      ].join("\n"),
    );

    await main(["--project", project]);
    const target = join(project, "src/fixture/runtime/_generated/sync/driver");
    assert.equal(readFileSync(join(target, "driver.py"), "utf8"), "value = 1\n");
    assert.equal(statSync(join(target, "driver.py")).mode & 0o222, 0);
    assert.equal(statSync(target).mode & 0o222, 0);
    assert.equal(existsSync(join(target, "tests")), false);

    chmodSync(target, 0o755);
    await main(["--project", project]);
    assert.equal(statSync(target).mode & 0o222, 0o200);
    await main(["--project", project, "--force"]);
    assert.equal(statSync(target).mode & 0o222, 0);
    await assert.doesNotReject(main(["--project", project, "--check"]));
  });
});
