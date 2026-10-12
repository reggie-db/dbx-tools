import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addSshProjectRequestSchema,
  sshCommandRequestSchema,
  sshProjectSchema,
} from "@dbx-tools/shared-databricks-sandbox";
import { parse } from "smol-toml";
import {
  generateProjectPort,
  normalizeProjectOpenPath,
  normalizeProjectPath,
  PROJECT_REMOVE_SCRIPT,
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

  it("injects hidden service tasks and adds them to the start dependencies", () => {
    const toml = renderProjectMiseConfig(
      {
        tasks: {
          prepare: { run: "prepare-project" },
          start: { depends: ["prepare"], run: "start-project" },
        },
      },
      { name: "demo", path: "/sandbox/abc/demo", port: 8080 },
      ["desktop", "terminal", "desktop"],
    );
    const parsed = parse(toml) as {
      tasks: Record<string, { depends?: string[]; hide?: boolean; run?: string }>;
    };

    assert.deepEqual(parsed.tasks.start?.depends, [
      "prepare",
      "sandbox:desktop",
      "sandbox:terminal",
    ]);
    assert.equal(parsed.tasks["sandbox:desktop"]?.hide, true);
    assert.equal(parsed.tasks["sandbox:terminal"]?.hide, true);
    assert.match(
      parsed.tasks["sandbox:desktop"]?.run ?? "",
      /projects\/\.sandbox-services\/desktop.*mise" run start/,
    );
  });

  it("runs optional mise stop and uninstall before deleting the project directory", () => {
    assert.match(PROJECT_REMOVE_SCRIPT, /for task in stop uninstall; do/);
    assert.match(
      PROJECT_REMOVE_SCRIPT,
      /if "\$mise_bin" tasks ls --name-only --hidden \| grep -Fxq "\$task"; then/,
    );
    assert.match(PROJECT_REMOVE_SCRIPT, /"\$mise_bin" run "\$task"/);
    assert.match(PROJECT_REMOVE_SCRIPT, /mise run %s failed \(ignored\)/);
    assert.match(PROJECT_REMOVE_SCRIPT, /stop_project_processes/);
    assert.match(PROJECT_REMOVE_SCRIPT, /readlink "\$proc\/cwd"/);
    assert.match(PROJECT_REMOVE_SCRIPT, /kill -KILL/);
    assert.match(PROJECT_REMOVE_SCRIPT, /rm -rf -- "\$project_directory"/);
  });
});

describe("Sandbox project contracts", () => {
  it("leaves update defaults to the runtime and accepts typed service dependencies", () => {
    const request = addSshProjectRequestSchema.parse({
      machineId: "sandbox-id",
      serviceDependencies: ["desktop", "terminal"],
    });

    assert.equal(request.route, undefined);
    assert.deepEqual(request.serviceDependencies, ["desktop", "terminal"]);
    assert.throws(
      () =>
        addSshProjectRequestSchema.parse({
          machineId: "sandbox-id",
          serviceDependencies: ["unknown"],
        }),
      /Invalid option/,
    );
  });

  it("accepts route-less project output without an open URL", () => {
    assert.doesNotThrow(() =>
      sshProjectSchema.parse({
        id: "project-id",
        name: "worker",
        machineId: "sandbox-id",
        directory: "~/projects/worker",
        path: "/sandbox/abc/worker",
        port: 8080,
        stripPrefix: true,
        state: "stopped",
      }),
    );
  });
});

describe("Sandbox command requests", () => {
  it("keeps the executable separate from its arguments", () => {
    assert.throws(
      () =>
        sshCommandRequestSchema.parse({
          machineId: "sandbox-id",
          command: "mise tasks ls --name-only --hidden",
        }),
      /one executable name/,
    );
    assert.doesNotThrow(() =>
      sshCommandRequestSchema.parse({
        machineId: "sandbox-id",
        command: "sh",
        args: ["-lc", '"$HOME/.local/bin/mise" tasks ls --name-only --hidden'],
      }),
    );
  });
});
