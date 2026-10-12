import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { databricksSandboxSkillMounts } from "../src/skills.ts";

const showcaseSkills = [
  "browser-synth",
  "fractal-lab",
  "freedoom-desktop",
  "jupyter-lab",
  "network-speed-test",
  "particle-physics-lab",
  "realtime-whiteboard",
  "vnc-server",
];

describe("databricksSandboxSkillMounts", () => {
  it("packages route-aware showcase recipes", async () => {
    const [mount] = databricksSandboxSkillMounts();
    assert.ok(mount);
    assert.equal(mount.mountPath, "/.dbx-tools/skills");
    const entries = await readdir(mount.root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const skill of showcaseSkills) {
      assert.ok(directories.includes(skill), `missing packaged skill ${skill}`);
      const source = await readFile(`${mount.root}/${skill}/SKILL.md`, "utf8");
      assert.match(source, /Project workflow is required/);
      assert.match(source, /add_ssh_project/);
      assert.match(source, /execute_ssh_command/);
      assert.match(source, /~\/.dbx-tools\/runtime/);
      assert.match(source, /loopback/i);
      assert.match(source, /openUrl/);
      assert.match(source, /mise/i);
    }
  });
});
