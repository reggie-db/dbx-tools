import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { databricksSandboxSkillMounts } from "../src/skills.ts";

const showcaseSkills = ["html-page", "jupyter-lab", "network-speed-test", "realtime-whiteboard"];

describe("databricksSandboxSkillMounts", () => {
  it("packages route-aware showcase recipes", async () => {
    const [mount] = databricksSandboxSkillMounts();
    assert.ok(mount);
    assert.equal(mount.mountPath, "/.dbx-tools/skills");
    const entries = await readdir(mount.root, { withFileTypes: true });
    const directories = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) =>
            (await readdir(`${mount.root}/${entry.name}`)).includes("SKILL.md")
              ? entry.name
              : undefined,
          ),
      )
    )
      .filter((entry): entry is string => entry !== undefined)
      .sort();
    assert.deepEqual(directories, showcaseSkills);

    for (const skill of showcaseSkills) {
      const source = await readFile(`${mount.root}/${skill}/SKILL.md`, "utf8");
      assert.match(source, /list_ssh_machines/);
      assert.match(source, /add_ssh_project/);
      assert.match(source, /loopback/i);
      assert.match(source, /openUrl/);
      assert.match(source, /Install script/);
      assert.match(source, /Start script/);
      assert.match(source, /server\.pid/);
      assert.match(source, /Markdown\s+link/);
      assert.doesNotMatch(source, /postinstall/);
      assert.doesNotMatch(source, /\b(?:sudo|apt-get|dnf|yum|pacman|pkexec)\b/);
    }
    const htmlPage = await readFile(`${mount.root}/html-page/SKILL.md`, "utf8");
    assert.match(htmlPage, /HTML_CONTENT/);
    assert.match(htmlPage, /printf %s "\$HTML_CONTENT"/);
    assert.doesNotMatch(htmlPage, /REPLACE_WITH_COMPLETE_APPLICATION_HTML/);
    const speedTest = await readFile(`${mount.root}/network-speed-test/SKILL.md`, "utf8");
    assert.match(speedTest, /github:librespeed\/speedtest-go/);
    assert.match(speedTest, /mise" --no-hooks exec -- speedtest-backend/);
    assert.doesNotMatch(speedTest, /command -v speedtest/);
    assert.doesNotMatch(speedTest, /REPLACE_WITH_COMPLETE_/);
    const whiteboard = await readFile(`${mount.root}/realtime-whiteboard/SKILL.md`, "utf8");
    assert.match(whiteboard, /lovasoa\/whitebophir/);
    assert.doesNotMatch(whiteboard, /REPLACE_WITH_COMPLETE_/);
    assert.doesNotMatch(whiteboard, /\bPROJECT_NAME=/);
  });
});
