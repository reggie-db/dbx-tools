import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { createLakeboxServiceRequestSchema } from "@dbx-tools/shared-lakebox";
import { lakeboxSkillMounts } from "../src/skills.ts";

const recipes = ["html-page", "jupyter-lab", "network-speed-test", "realtime-whiteboard"];

describe("lakeboxSkillMounts", () => {
  it("packages one valid service request per recipe", async () => {
    const [mount] = lakeboxSkillMounts();
    assert.ok(mount);
    assert.equal(mount.mountPath, "/.dbx-tools/skills");
    const entries = (await readdir(mount.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(entries, recipes);
    for (const recipe of recipes) {
      const source = await readFile(`${mount.root}/${recipe}/SKILL.md`, "utf8");
      assert.match(source, /create_lakebox_service/);
      assert.match(source, /openUrl/);
      assert.doesNotMatch(source, /ssh_project|mise|PROJECT_PORT|\b(?:sudo|apt-get)\b/);
      const request = /```json\n([\s\S]+?)\n```/.exec(source)?.[1];
      assert.ok(request, `${recipe} includes a complete request`);
      const parsed = createLakeboxServiceRequestSchema.parse(JSON.parse(request));
      assert.ok(parsed.command?.join(" ").includes("SERVICE_PORT"));
    }
  });
});
