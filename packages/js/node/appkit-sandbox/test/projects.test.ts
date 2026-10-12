import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "smol-toml";
import {
  generateProjectPort,
  normalizeProjectOpenPath,
  normalizeProjectPath,
  renderProjectMiseConfig,
} from "../src/_projects.ts";

describe("Sandbox project configuration", () => {
  it("normalizes project and open paths", () => {
    assert.equal(normalizeProjectPath("/demo/app/"), "demo/app");
    assert.equal(normalizeProjectOpenPath("/open.html?mode=full"), "open.html?mode=full");
    assert.equal(normalizeProjectOpenPath("/"), undefined);
    assert.throws(() => normalizeProjectPath("../demo"), /project path/);
    assert.throws(() => normalizeProjectOpenPath("https://example.com"), /project-relative/);
  });

  it("generates a port not already reserved on the machine", () => {
    const used = new Set(Array.from({ length: 1_000 }, (_, index) => 8_000 + index));
    const port = generateProjectPort(used);
    assert.equal(used.has(port), false);
  });

  it("serializes mise config and injects reserved project values", () => {
    const toml = renderProjectMiseConfig(
      { tools: { node: "lts" }, env: { APP_MODE: "demo" } },
      { name: "demo", path: "/sandbox/abc/demo", port: 8080 },
    );
    const parsed = parse(toml) as {
      tools: { node: string };
      env: Record<string, string>;
    };
    assert.equal(parsed.tools.node, "lts");
    assert.deepEqual(parsed.env, {
      APP_MODE: "demo",
      PROJECT_NAME: "demo",
      PROJECT_PATH: "/sandbox/abc/demo",
      PROJECT_PORT: "8080",
    });
  });

  it("rejects conflicting reserved mise environment values", () => {
    assert.throws(
      () =>
        renderProjectMiseConfig(
          { env: { PROJECT_PORT: "3000" } },
          { name: "demo", path: "/sandbox/abc/demo", port: 8080 },
        ),
      /PROJECT_PORT must equal "8080"/,
    );
  });
});
