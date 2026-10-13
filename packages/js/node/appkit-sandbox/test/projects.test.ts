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
  mergeProjectMiseConfig,
  normalizeProjectOpenPath,
  normalizeProjectPath,
  PROJECT_REMOVE_SCRIPT,
  PROJECT_SETUP_SCRIPT,
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

  it("preserves project tasks without injecting service dependencies", () => {
    const toml = renderProjectMiseConfig(
      {
        tasks: {
          prepare: { run: "prepare-project" },
          start: { depends: ["prepare"], run: "start-project" },
        },
      },
      { name: "demo", path: "/sandbox/abc/demo", port: 8080 },
    );
    const parsed = parse(toml) as {
      tasks: Record<string, { depends?: string[]; hide?: boolean; run?: string }>;
    };

    assert.deepEqual(parsed.tasks.start?.depends, ["prepare"]);
    assert.equal(parsed.tasks["sandbox:desktop"], undefined);
  });

  it("runs only optional mise uninstall before deleting the project directory", () => {
    assert.match(
      PROJECT_REMOVE_SCRIPT,
      /if "\$mise_bin" tasks ls --name-only --hidden \| grep -Fxq uninstall; then/,
    );
    assert.match(PROJECT_REMOVE_SCRIPT, /"\$mise_bin" run uninstall/);
    assert.doesNotMatch(PROJECT_REMOVE_SCRIPT, /run stop/);
    assert.match(PROJECT_REMOVE_SCRIPT, /stop_project_processes/);
    assert.match(PROJECT_REMOVE_SCRIPT, /readlink "\$proc\/cwd"/);
    assert.match(PROJECT_REMOVE_SCRIPT, /kill -KILL/);
    assert.match(PROJECT_REMOVE_SCRIPT, /operation_lock=.*lifecycle\.lock/);
    assert.match(PROJECT_REMOVE_SCRIPT, /operation_pid=\$\(cat "\$operation_lock\/pid"/);
    assert.match(PROJECT_REMOVE_SCRIPT, /kill_tree "\$operation_pid"/);
    assert.match(PROJECT_REMOVE_SCRIPT, /rm -rf -- "\$project_directory"/);
    assert.match(PROJECT_REMOVE_SCRIPT, /rm -rf -- "\$operation_directory"/);
  });

  it("runs project install through a bounded home-level lifecycle log", () => {
    assert.match(PROJECT_SETUP_SCRIPT, /\.dbx-tools\/operations\/projects/);
    assert.match(PROJECT_SETUP_SCRIPT, /lifecycle\.lock/);
    assert.match(PROJECT_SETUP_SCRIPT, /lifecycle\.log/);
    assert.match(PROJECT_SETUP_SCRIPT, /maximum_attempts=2/);
    assert.match(PROJECT_SETUP_SCRIPT, /__DBX_TOOLS_ATTEMPT__/);
    assert.match(PROJECT_SETUP_SCRIPT, /__DBX_TOOLS_RESULT__/);
    assert.match(PROJECT_SETUP_SCRIPT, /install_is_complete/);
    assert.match(PROJECT_SETUP_SCRIPT, /rm -rf -- "\$project_directory"/);
  });

  it("merges first-class mise options over raw config", () => {
    const merged = mergeProjectMiseConfig(
      {
        tools: { node: "20", python: "3.12" },
        hooks: { postinstall: "old-install" },
        tasks: { uninstall: { run: "old-uninstall" }, start: { run: "start" } },
      },
      {
        tools: { node: "lts" },
        postinstall: "new-install",
        uninstall: "new-uninstall",
      },
    );
    assert.deepEqual(merged.tools, { node: "lts", python: "3.12" });
    assert.deepEqual(merged.hooks, { postinstall: "new-install" });
    assert.deepEqual(merged.tasks, {
      uninstall: { run: "new-uninstall" },
      start: { run: "start" },
    });
  });
});

describe("Sandbox project contracts", () => {
  it("leaves update defaults to the runtime and accepts typed service dependencies", () => {
    const request = addSshProjectRequestSchema.parse({
      machineId: "sandbox-id",
      serviceDependencies: ["desktop", "terminal"],
      tools: { node: "lts" },
      postinstall: "prepare-project",
      uninstall: "remove-project",
    });

    assert.equal(request.route, undefined);
    assert.deepEqual(request.serviceDependencies, ["desktop", "terminal"]);
    assert.deepEqual(request.tools, { node: "lts" });
    assert.equal(request.postinstall, "prepare-project");
    assert.equal(request.uninstall, "remove-project");
    assert.match(
      addSshProjectRequestSchema.shape.config.description ?? "",
      /https:\/\/mise\.jdx\.dev\/schema\/mise\.json/,
    );
    assert.match(addSshProjectRequestSchema.shape.postinstall.description ?? "", /check-lock-check/);
    assert.match(
      addSshProjectRequestSchema.shape.uninstall.description ?? "",
      /only this project task/,
    );
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

  it("rejects Databricks credential environment overlays", () => {
    assert.throws(
      () =>
        sshCommandRequestSchema.parse({
          machineId: "sandbox-id",
          command: "sh",
          env: { DATABRICKS_TOKEN: "service-principal-token" },
        }),
      /dedicated app-mediated OBO capability/,
    );
  });
});
