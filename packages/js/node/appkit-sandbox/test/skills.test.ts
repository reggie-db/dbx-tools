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
      assert.match(source, /list_ssh_machines/);
      assert.match(source, /add_ssh_project/);
      assert.match(source, /execute_ssh_command/);
      assert.match(source, /~\/.dbx-tools\/runtime/);
      assert.match(source, /loopback/i);
      assert.match(source, /openUrl/);
      assert.match(source, /mise/i);
      assert.match(source, /## Setup project options/);
      assert.match(source, /\[tasks\.start\]\nrun = '''/);
      assert.match(source, /\[tasks\.stop\]\nrun = '''/);
      assert.match(source, /tasks ls --name-only --hidden/);
      assert.match(source, /run start/);
      assert.match(source, /run stop/);
      assert.match(source, /command: "sh"/);
      assert.match(source, /args: \["-lc",/);
      assert.doesNotMatch(source, /command: "mise /);
      assert.doesNotMatch(source, /\[tasks\.run\]/);
      assert.doesNotMatch(source, /hide = true/);
      assert.match(
        source,
        /Do not install\s+packages, write launch scripts, or start\s+servers/,
      );
    }

    for (const skill of ["vnc-server"]) {
      assert.ok(directories.includes(skill), `missing packaged skill ${skill}`);
      const source = await readFile(`${mount.root}/${skill}/SKILL.md`, "utf8");
      assert.match(source, /start_ssh_machine_service/);
      assert.match(source, /service: "desktop"/);
      assert.match(source, /openUrl/);
      assert.match(source, /built-in/i);
    }

    const freedoom = await readFile(`${mount.root}/freedoom-desktop/SKILL.md`, "utf8");
    assert.match(freedoom, /list_ssh_machines/);
    assert.match(freedoom, /add_ssh_project/);
    assert.match(freedoom, /route: false/);
    assert.match(freedoom, /serviceDependencies: \["desktop"\]/);
    assert.match(freedoom, /sandbox:desktop/);
    assert.match(freedoom, /## Setup project options/);
    assert.match(freedoom, /\[hooks\]\npostinstall = '''/);
    assert.match(freedoom, /\[tasks\.start\]\nrun = '''/);
    assert.match(freedoom, /\[tasks\.stop\]\nrun = '''/);
    assert.doesNotMatch(freedoom, /\[tasks\.uninstall\]/);
    assert.match(freedoom, /pkill -P "\$pid"/);
    assert.match(freedoom, /pkill -x crispy-doom/);
    assert.match(freedoom, /pkill -x prboom-plus/);
    assert.doesNotMatch(freedoom, /kasmvnc(server)? /i);
    assert.match(freedoom, /~\/\.dbx-tools\/runtime\/desktop\/run/);
    assert.doesNotMatch(freedoom, /DISPLAY=:\d+/);
    assert.doesNotMatch(freedoom, /ls \/tmp\/\.X11-unix/);
    const jupyter = await readFile(`${mount.root}/jupyter-lab/SKILL.md`, "utf8");
    assert.match(jupyter, /\[hooks\]\npostinstall = '''/);
    const desktop = await readFile(`${mount.root}/vnc-server/SKILL.md`, "utf8");
    assert.doesNotMatch(desktop, /add_ssh_project/);
    assert.doesNotMatch(desktop, /apt-get/);
    assert.match(desktop, /~\/\.dbx-tools\/runtime\/desktop\/run/);
    assert.doesNotMatch(desktop, /DISPLAY=:\d+/);
  });
});
