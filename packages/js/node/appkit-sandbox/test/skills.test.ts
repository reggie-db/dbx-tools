import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { parse } from "smol-toml";
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
      assert.match(source, /Project workflow is required/);
      assert.match(source, /list_ssh_machines/);
      assert.match(source, /add_ssh_project/);
      assert.match(source, /~\/.dbx-tools\/runtime/);
      assert.match(source, /loopback/i);
      assert.match(source, /openUrl/);
      assert.match(source, /mise/i);
      assert.match(source, /## Setup project options/);
      assert.match(source, /first-class `uninstall`/);
      assert.match(source, /unprivileged\s+`sandbox-user`/);
      assert.match(source, /\[hooks\]\npostinstall = '''/);
      assert.match(source, /waits? until/i);
      assert.match(source, /Markdown link/);
      assert.doesNotMatch(source, /\[tasks\.start\]/);
      assert.doesNotMatch(source, /\[tasks\.stop\]/);
      assert.doesNotMatch(source, /--hidden/);
      assert.doesNotMatch(source, /\[tasks\.run\]/);
      assert.doesNotMatch(source, /hide = true/);
      assert.doesNotMatch(source, /\b(?:sudo|apt-get|dnf|yum|pacman|pkexec)\b/);
      assert.match(source, /Do not define\s+`start`, `stop`, or\s+hidden tasks/);
      const toml = source.match(/```toml\n([\s\S]*?)\n```/)?.[1];
      assert.ok(toml);
      const config = parse(toml) as {
        hooks?: { postinstall?: string };
        tasks?: Record<string, unknown>;
      };
      assert.ok(config.hooks?.postinstall);
      assert.equal(config.tasks?.start, undefined);
      assert.equal(config.tasks?.stop, undefined);
    }
    const htmlPage = await readFile(`${mount.root}/html-page/SKILL.md`, "utf8");
    assert.match(htmlPage, /Web Audio synthesizer/);
    assert.match(htmlPage, /Mandelbrot and Julia explorer/);
    assert.match(htmlPage, /particle and gravity simulation/);
    assert.match(htmlPage, /env\.HTML_CONTENT/);
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
