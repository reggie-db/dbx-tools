import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
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
  PROJECT_INSTALL_MARKER,
  PROJECT_INSTALL_TASK,
  PROJECT_REMOVE_SCRIPT,
  PROJECT_SETUP_SCRIPT,
  PROJECT_START_MARKER,
  PROJECT_START_TASK,
  PROJECT_UNINSTALL_TASK,
  renderProjectMiseConfig,
} from "../src/_projects.ts";

const execFileAsync = promisify(execFile);

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
      settings?: Record<string, string>;
    };
    assert.equal(parsed.tools.node, "lts");
    assert.deepEqual(parsed.env, {
      APP_MODE: "demo",
      PROJECT_NAME: "demo",
      PROJECT_PATH: "/sandbox/abc/demo",
      PROJECT_PORT: "8080",
    });
    assert.equal(parsed.settings, undefined);
  });

  it("preserves explicit mise shell settings", () => {
    const toml = renderProjectMiseConfig(
      {
        settings: {
          unix_default_file_shell_args: "zsh",
          unix_default_inline_shell_args: "zsh -c",
        },
      },
      { name: "demo", path: "/sandbox/abc/demo", port: 8080 },
    );
    const parsed = parse(toml) as { settings: Record<string, string> };

    assert.deepEqual(parsed.settings, {
      unix_default_file_shell_args: "zsh",
      unix_default_inline_shell_args: "zsh -c",
    });
  });

  it("maps lifecycle fields to hidden runtime-owned mise tasks", () => {
    const merged = mergeProjectMiseConfig(undefined, {
      install: "prepare-project",
      start: "start-project",
      uninstall: "remove-project",
    });
    assert.deepEqual(merged.tasks, {
      [PROJECT_INSTALL_TASK]: { run: "prepare-project", hide: true },
      [PROJECT_START_TASK]: { run: "start-project", hide: true },
      [PROJECT_UNINSTALL_TASK]: { run: "remove-project", hide: true },
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
    const toml = renderProjectMiseConfig(
      { env: { PROJECT_PORT: "8080", HTML_CONTENT: "<html></html>" } },
      { name: "demo", path: "/sandbox/abc/demo", port: 8080 },
    );
    const parsed = parse(toml) as { env: Record<string, string> };
    assert.equal(parsed.env.PROJECT_PORT, "8080");
    assert.equal(parsed.env.HTML_CONTENT, "<html></html>");
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
      /if "\$mise_bin" tasks ls --name-only --hidden \| grep -Fxq "\$uninstall_task"; then/,
    );
    assert.match(PROJECT_REMOVE_SCRIPT, /"\$mise_bin" run "\$uninstall_task"/);
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
    assert.match(PROJECT_SETUP_SCRIPT, /lifecycle_is_complete/);
    assert.match(PROJECT_SETUP_SCRIPT, /boot_id=/);
    assert.match(PROJECT_SETUP_SCRIPT, /task_exists "\$install_task"/);
    assert.match(PROJECT_SETUP_SCRIPT, /task_exists "\$start_task"/);
  });

  it("runs install once per config and start once per machine boot", async () => {
    const home = await mkdtemp(join(tmpdir(), "dbx-tools-project-setup-"));
    const binDirectory = join(home, ".local", "bin");
    const setupScript = join(home, "setup-project.sh");
    const miseScript = join(binDirectory, "mise");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(setupScript, PROJECT_SETUP_SCRIPT);
    await chmod(setupScript, 0o700);
    await writeFile(
      miseScript,
      `#!/bin/sh
if [ "$1" = trust ] || [ "$1" = install ]; then exit 0; fi
if [ "$1" = tasks ] && [ "$2" = ls ]; then
  [ "$PWD" = "$HOME/projects/managed-project" ] || exit 3
  printf '%s\n%s\n' '${PROJECT_INSTALL_TASK}' '${PROJECT_START_TASK}'
  exit 0
fi
if [ "$1" = run ]; then
  printf '%s\n' "$2" >> "$HOME/task-runs.txt"
  exit 0
fi
exit 2
`,
    );
    await chmod(miseScript, 0o700);

    const args = [
      "managed-project",
      "",
      Buffer.from("[tools]\npython = '3.12'\n").toString("base64"),
      PROJECT_INSTALL_TASK,
      PROJECT_START_TASK,
      PROJECT_INSTALL_MARKER,
      PROJECT_START_MARKER,
    ];
    await execFileAsync(setupScript, args, { env: { ...process.env, HOME: home } });
    await execFileAsync(setupScript, args, { env: { ...process.env, HOME: home } });
    assert.deepEqual((await readFile(join(home, "task-runs.txt"), "utf8")).trim().split("\n"), [
      PROJECT_INSTALL_TASK,
      PROJECT_START_TASK,
    ]);
    await writeFile(
      join(home, "projects", "managed-project", PROJECT_START_MARKER),
      "previous-machine-boot\n",
    );
    await execFileAsync(setupScript, args, { env: { ...process.env, HOME: home } });
    assert.deepEqual((await readFile(join(home, "task-runs.txt"), "utf8")).trim().split("\n"), [
      PROJECT_INSTALL_TASK,
      PROJECT_START_TASK,
      PROJECT_START_TASK,
    ]);
  });

  it("merges first-class mise options over raw config", () => {
    const merged = mergeProjectMiseConfig(
      {
        tools: { node: "20", python: "3.12" },
        env: { MODE: "demo" },
        tasks: { user: { run: "user-task" } },
      },
      {
        tools: { node: "lts" },
        env: { HTML_CONTENT: "<html></html>", MODE: "prod" },
        install: "new-install",
        start: "new-start",
        uninstall: "new-uninstall",
      },
    );
    assert.deepEqual(merged.tools, { node: "lts", python: "3.12" });
    assert.deepEqual(merged.env, { MODE: "prod", HTML_CONTENT: "<html></html>" });
    assert.deepEqual(merged.tasks, {
      user: { run: "user-task" },
      [PROJECT_INSTALL_TASK]: { run: "new-install", hide: true },
      [PROJECT_START_TASK]: { run: "new-start", hide: true },
      [PROJECT_UNINSTALL_TASK]: { run: "new-uninstall", hide: true },
    });
  });

  it("parses string config as JSON objects or TOML", () => {
    assert.deepEqual(mergeProjectMiseConfig('{"tools":{"node":"lts"}}', {}), {
      tools: { node: "lts" },
    });
    assert.deepEqual(mergeProjectMiseConfig('[tools]\nnode = "lts"\n[env]\nMODE = "demo"\n', {}), {
      tools: { node: "lts" },
      env: { MODE: "demo" },
    });
  });

  it("rejects malformed or non-object string config", () => {
    assert.throws(() => mergeProjectMiseConfig("[tools\nnode = ", {}), /JSON object or valid TOML/);
    assert.throws(() => mergeProjectMiseConfig("true", {}), /JSON object or valid TOML/);
    assert.throws(
      () => mergeProjectMiseConfig({ env: { DATABRICKS_TOKEN: "token" } }, {}),
      /Databricks or SSH agent credentials/,
    );
  });
});

describe("Sandbox project contracts", () => {
  it("leaves update defaults to the runtime and accepts typed service dependencies", () => {
    const request = addSshProjectRequestSchema.parse({
      machineId: "sandbox-id",
      serviceDependencies: ["desktop", "terminal"],
      tools: { node: "lts" },
      install: "prepare-project",
      start: "start-project",
      uninstall: "remove-project",
    });

    assert.equal(request.route, undefined);
    assert.deepEqual(request.serviceDependencies, ["desktop", "terminal"]);
    assert.deepEqual(request.tools, { node: "lts" });
    assert.equal(request.install, "prepare-project");
    assert.equal(request.start, "start-project");
    assert.equal(request.uninstall, "remove-project");
    assert.deepEqual(
      addSshProjectRequestSchema.parse({
        machineId: "sandbox-id",
        env: { HTML_CONTENT: "<html></html>" },
      }).env,
      { HTML_CONTENT: "<html></html>" },
    );
    assert.throws(
      () =>
        addSshProjectRequestSchema.parse({
          machineId: "sandbox-id",
          env: { DATABRICKS_TOKEN: "token" },
        }),
      /Databricks or SSH agent credentials/,
    );
    assert.match(
      addSshProjectRequestSchema.shape.config.description ?? "",
      /JSON object string, or TOML string/,
    );
    assert.equal(
      addSshProjectRequestSchema.parse({
        machineId: "sandbox-id",
        config: '[tools]\nnode = "lts"',
      }).config,
      '[tools]\nnode = "lts"',
    );
    assert.match(addSshProjectRequestSchema.shape.install.description ?? "", /_dbx-tools-install/);
    assert.match(addSshProjectRequestSchema.shape.start.description ?? "", /machine boot/);
    assert.match(
      addSshProjectRequestSchema.shape.uninstall.description ?? "",
      /_dbx-tools-uninstall/,
    );
    assert.match(addSshProjectRequestSchema.shape.env.description ?? "", /HTML_CONTENT/);
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
        directory: "/home/sandbox-user/projects/worker",
        path: "/sandbox/abc/worker",
        port: 8080,
        stripPrefix: true,
        redirectToSlash: true,
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

  it("rejects public sudo requests", () => {
    assert.throws(
      () =>
        sshCommandRequestSchema.parse({
          machineId: "sandbox-id",
          command: "id",
          sudo: true,
        }),
      /unrecognized key/i,
    );
  });
});
