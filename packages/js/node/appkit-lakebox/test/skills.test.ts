import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { databricksWorkspace } from "@dbx-tools/appkit-mastra";
import { createLakeboxServiceRequestSchema } from "@dbx-tools/shared-lakebox";
import { RequestContext } from "@mastra/core/request-context";
import { AppKitLakeboxPlugin } from "../src/plugin.ts";
import type { LakeboxRuntime } from "../src/runtime.ts";
import { lakeboxSkillMounts } from "../src/skills.ts";

const recipes = [
  "html-page",
  "jupyter-lab",
  "lakebox-showcase",
  "network-speed-test",
  "realtime-whiteboard",
];

before(async () => {
  await CacheManager.getInstance();
});

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
      assert.match(source, /description: .*\b(?:deploy|service)\b/i);
      assert.match(source, /create_lakebox_service/);
      assert.match(source, /openUrl/);
      assert.doesNotMatch(source, /ssh_project|mise|PROJECT_PORT|\b(?:sudo|apt-get)\b/);
      const request = /```json\n([\s\S]+?)\n```/.exec(source)?.[1];
      assert.ok(request, `${recipe} includes a complete request`);
      const parsed = createLakeboxServiceRequestSchema.parse(JSON.parse(request));
      assert.ok(parsed.command?.join(" ").includes("SERVICE_PORT"));
    }
  });

  it("routes generic app, page, and service deployment requests to the HTML recipe", async () => {
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      extraSkillMounts: lakeboxSkillMounts(),
    });
    const configured = workspace.skills;
    assert.ok(configured);
    const skills =
      (await configured.getScoped?.({ requestContext: new RequestContext() })) ?? configured;
    for (const query of [
      "deploy a service",
      "deploy an app",
      "deploy a page",
      "deploy interactive web app service sandbox HTML Three.js 3D game",
    ]) {
      assert.equal((await skills.search(query))[0]?.skillName, "html-page", query);
    }
  });

  it("routes broad Lakebox capability and demo questions to the showcase", async () => {
    const workspace = databricksWorkspace({
      assistantPaths: false,
      sandbox: false,
      extraSkillMounts: lakeboxSkillMounts(),
    });
    const configured = workspace.skills;
    assert.ok(configured);
    const skills =
      (await configured.getScoped?.({ requestContext: new RequestContext() })) ?? configured;
    for (const query of [
      "what can I do with Lakebox",
      "give me fun Lakebox Docker demo ideas",
      "showcase a one-port browser app in Lakebox",
    ]) {
      assert.equal((await skills.search(query))[0]?.skillName, "lakebox-showcase", query);
    }
  });
});

describe("AppKitLakeboxPlugin agent tools", () => {
  it("keeps command and service tools while excluding whole-Lakebox lifecycle controls", () => {
    const plugin = new AppKitLakeboxPlugin({ runtime: {} as LakeboxRuntime });
    const operationNames = [
      "get_lakebox",
      "execute_lakebox_command",
      "list_lakebox_services",
      "create_lakebox_service",
      "start_lakebox_service",
      "stop_lakebox_service",
      "remove_lakebox_service",
      "get_lakebox_service_logs",
    ];
    assert.deepEqual(Object.keys(plugin.operations("user")), operationNames);
    assert.deepEqual(Object.keys(plugin.toolkit()), operationNames);
    assert.equal("start_lakebox" in plugin.operations("user"), false);
    assert.equal("stop_lakebox" in plugin.operations("user"), false);
    assert.equal("delete_lakebox" in plugin.operations("user"), false);
  });
});
