import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { databricksSandboxSkillMounts } from "../src/skills.ts";

const showcaseSkills = [
  "browser-synth",
  "fractal-lab",
  "jupyter-lab",
  "network-speed-test",
  "particle-physics-lab",
  "realtime-whiteboard",
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

    for (const skill of ["freedoom-desktop", "vnc-server"]) {
      assert.ok(directories.includes(skill), `missing packaged skill ${skill}`);
      const source = await readFile(`${mount.root}/${skill}/SKILL.md`, "utf8");
      assert.match(source, /start_ssh_machine_service/);
      assert.match(source, /service: "desktop"/);
      assert.match(source, /openUrl/);
      assert.match(source, /built-in/i);
      assert.doesNotMatch(source, /apt-get/);
    }

    const freedoom = await readFile(`${mount.root}/freedoom-desktop/SKILL.md`, "utf8");
    assert.match(freedoom, /add_ssh_project/);
    assert.match(freedoom, /DISPLAY=:20/);
    const desktop = await readFile(`${mount.root}/vnc-server/SKILL.md`, "utf8");
    assert.doesNotMatch(desktop, /add_ssh_project/);
  });
});
