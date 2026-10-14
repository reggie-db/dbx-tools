import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { brandUtils } from "@dbx-tools/shared-core";
import type { SshCommandResult } from "@dbx-tools/shared-databricks-sandbox";
import { dbxToolsAssetSvg } from "@dbx-tools/ui/branding/assets";
import { parse } from "smol-toml";
import { completedSshCommand } from "./ssh-command.ts";
import {
  ensureSshService,
  inspectSshLifecycleStates,
  loadSshServiceDefinition,
  projectTerminalOpenUrl,
  readSshServiceOperationLog,
  type SshServiceDefinition,
} from "../src/services.ts";
import type { SshSession } from "../src/session.ts";

const success: SshCommandResult = {
  command: "sh",
  args: ["-lc"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  success: true,
  executionTimeMs: 1,
};

interface MiseServiceDocument {
  hooks: {
    postinstall: string;
  };
  tasks: {
    start: {
      hide: boolean;
      run: string;
    };
    stop: {
      hide: boolean;
      run: string;
    };
    status: {
      hide: boolean;
      run: string;
    };
  };
}

function serviceDocument(definition: SshServiceDefinition): MiseServiceDocument {
  return parse(definition.miseToml) as unknown as MiseServiceDocument;
}

describe("packaged Sandbox services", () => {
  it("loads a pinned ttyd definition with hidden lifecycle tasks", () => {
    const definition = loadSshServiceDefinition("terminal", "/sandbox/terminal/machine");
    const document = serviceDocument(definition);

    assert.equal(definition.directory, "/home/sandbox-user/projects/.sandbox-services/terminal");
    assert.match(document.hooks.postinstall, /version="1\.7\.7"/);
    assert.match(
      document.hooks.postinstall,
      /aarch64\) checksum="b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165"/,
    );
    assert.match(
      document.hooks.postinstall,
      /x86_64\) checksum="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"/,
    );
    assert.match(document.hooks.postinstall, /github\.com\/tsl0922\/ttyd\/releases\/download/);
    assert.match(document.hooks.postinstall, /ttyd checksum mismatch/);
    assert.match(document.hooks.postinstall, /dbx-tools-shell/);
    assert.match(document.hooks.postinstall, /dbx-tools-bashrc/);
    assert.match(document.hooks.postinstall, /dbx-tools-project-bashrc/);
    assert.match(document.hooks.postinstall, /mise" activate bash/);
    assert.match(document.tasks.start.run, /--interface 127\.0\.0\.1 --port 7681/);
    assert.match(document.tasks.start.run, /--writable --url-arg/);
    assert.match(document.tasks.start.run, /--client-option rendererType=webgl/);
    assert.match(document.hooks.postinstall, /\/proc\/\$pid\/cmdline/);
    assert.match(document.tasks.start.run, /\/proc\/\$pid\/cmdline/);
    assert.match(document.tasks.start.run, /ttyd did not become ready/);
    assert.match(document.tasks.stop.run, /stop-ttyd/);
    assert.match(document.tasks.status.run, /ttyd\.pid/);
    assert.match(
      document.tasks.status.run,
      /timeout --signal=KILL 1 bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/7681'/,
    );
    assert.equal(document.tasks.start.hide, true);
    assert.equal(document.tasks.stop.hide, true);
    assert.equal(document.tasks.status.hide, true);
    assert.equal(definition.target.remotePort, 7681);
    assert.equal(definition.target.stripPrefix, true);
    assert.equal(definition.target.redirectToSlash, true);
    assert.equal(definition.target.openUrl, "/sandbox/terminal/machine/");
  });

  it("loads an optimized official KasmVNC desktop definition", async () => {
    const definition = loadSshServiceDefinition("desktop", "/sandbox/desktop/machine");
    const document = serviceDocument(definition);
    const install = document.hooks.postinstall;
    const start = document.tasks.start.run;
    const prerequisites = await readFile(
      new URL("../scripts/setup-desktop-prerequisites.sh", import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(install, /sudo|apt-get|dpkg/);
    assert.match(prerequisites, /kasmvnc_version=1\.5\.0/);
    assert.match(
      prerequisites,
      /package_name="kasmvncserver_\$\{codename\}_\$\{kasmvnc_version\}_\$architecture\.deb"/,
    );
    assert.match(
      prerequisites,
      /https:\/\/github\.com\/kasmtech\/KasmVNC\/releases\/download\/v\$\{kasmvnc_version\}/,
    );
    assert.match(
      prerequisites,
      /noble-amd64\) package_checksum="f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e"/,
    );
    assert.match(
      prerequisites,
      /noble-arm64\) package_checksum="c9199cf4753208bfb69fd016a9780242bebfc43370cc38c97d61e90a3c783e04"/,
    );
    assert.match(prerequisites, /apt-get update/);
    assert.doesNotMatch(prerequisites, /freedoom|prboom-plus/);
    assert.match(prerequisites, /sha256sum --check --status/);
    assert.equal(install.match(/rsvg-convert --width/g)?.length, 3);
    assert.match(install, /desktop_runner="\$runtime\/run"/);
    assert.match(install, /printf 'export DISPLAY=:%s\\n' '20'/);
    assert.match(install, /\. "\$HOME\/\.dbx-tools\/runtime\/desktop\/environment"/);
    assert.match(install, /exec "\$@"/);
    assert.doesNotMatch(install, /ls \/tmp\/\.X11-unix|sed .*DISPLAY/);
    assert.match(install, /dbx-tools-browser\.desktop/);
    assert.match(install, /dbx-tools-terminal\.desktop/);
    assert.match(install, /WebBrowser=dbx-tools-browser/);
    assert.match(install, /Arc-Dark/);
    assert.match(install, /IconThemeName string hicolor/);
    assert.match(install, /exec dbus-run-session --/);
    assert.match(install, /startxfce4/);
    assert.match(install, /Xfce desktop shell did not become ready/);
    assert.match(start, /kasmvncserver :20 -fg/);
    assert.match(install, /org\.gnome\.Epiphany ask-for-default false/);
    assert.match(start, /-select-de xfce -xstartup/);
    assert.match(start, /-websocketPort 6080/);
    assert.match(start, /-disableBasicAuth -SecurityTypes None/);
    assert.match(install, /\/proc\/\$pid\/cmdline/);
    assert.match(start, /\/proc\/\$pid\/cmdline/);
    assert.match(start, /KasmVNC web client did not become ready/);
    assert.equal(document.tasks.start.hide, true);
    assert.equal(document.tasks.stop.hide, true);
    assert.match(document.tasks.status.run, /kasmvncserver\.pid/);
    assert.match(document.tasks.status.run, /session\.ready/);
    assert.match(
      document.tasks.status.run,
      /timeout --signal=KILL 1 bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/6080'/,
    );
    assert.equal(document.tasks.status.hide, true);

    const wallpaper = Buffer.from(
      definition.environment.DBX_TOOLS_DESKTOP_WALLPAPER_BASE64 ?? "",
      "base64",
    ).toString("utf8");
    for (const color of [
      brandUtils.defaultBrandContext.colors.primary,
      brandUtils.defaultBrandContext.colors.primaryHover,
      brandUtils.defaultBrandContext.colors.accent,
      brandUtils.defaultBrandContext.colors.surface,
      brandUtils.defaultBrandContext.colors.muted,
    ]) {
      assert.match(wallpaper, new RegExp(color, "i"));
    }
    assert.match(wallpaper, /dbx tools logo/);
    assert.match(
      wallpaper,
      new RegExp(dbxToolsAssetSvg.logoDark.match(/<path d="([^"]+)"/)?.[1] ?? "$^"),
    );

    assert.equal(definition.target.remotePort, 6080);
    assert.equal(definition.target.stripPrefix, true);
    assert.equal(definition.target.redirectToSlash, true);
    assert.match(definition.target.htmlHead ?? "", /dbx-tools-desktop-brand/);
    assert.match(definition.target.htmlHead ?? "", /KasmVNC Learn More/);
    assert.match(definition.target.htmlHead ?? "", /dbx-tools-kasm-mobile-guard/);
    assert.match(definition.target.htmlHead ?? "", /Can't find variable: W\[0-9A-F\]/);
    assert.match(definition.target.htmlHead ?? "", /stopImmediatePropagation/);
    assert.match(definition.target.htmlHead ?? "", /visualViewport/);
    assert.match(definition.target.htmlHead ?? "", /--dbx-tools-viewport-width/);
    assert.match(definition.target.htmlHead ?? "", /orientationchange/);
    assert.match(definition.target.htmlHead ?? "", /setTimeout\(sync,750\)/);
    assert.match(definition.target.htmlHead ?? "", /overflow-wrap:anywhere/);
    assert.match(definition.target.htmlHead ?? "", /document\.title="dbx tools Desktop"/);
    assert.equal(
      definition.target.openUrl,
      "/sandbox/desktop/machine/?autoconnect=1&resize=remote&show_dot=1&clipboard_seamless=0&enable_webp=0&kasmvnc_mode_preference=-1027&path=sandbox%2Fdesktop%2Fmachine%2Fwebsockify",
    );
  });

  it("loads Glances installation, lifecycle, and route metadata", () => {
    const definition = loadSshServiceDefinition("stats", "/sandbox/metrics/machine");
    const document = serviceDocument(definition);

    assert.match(document.hooks.postinstall, /version="4\.5\.6"/);
    assert.match(document.hooks.postinstall, /glances\[web\]==\$version/);
    assert.doesNotMatch(document.hooks.postinstall, /sudo|apt-get/);
    assert.match(document.hooks.postinstall, /url_prefix=\$\{DBX_TOOLS_SERVICE_PATH%\/\}\//);
    assert.match(document.tasks.start.run, /--bind 127\.0\.0\.1/);
    assert.match(document.tasks.start.run, /--port 61208/);
    assert.match(document.tasks.start.run, /Glances did not become ready/);
    assert.match(document.hooks.postinstall, /\/proc\/\$pid\/cmdline/);
    assert.match(document.tasks.start.run, /\/proc\/\$pid\/cmdline/);
    assert.match(document.tasks.stop.run, /stop-glances/);
    assert.match(document.tasks.status.run, /glances\.pid/);
    assert.match(
      document.tasks.status.run,
      /timeout --signal=KILL 1 bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/61208'/,
    );
    assert.equal(document.tasks.status.hide, true);
    assert.equal(definition.environment.DBX_TOOLS_SERVICE_PATH, "/sandbox/metrics/machine");
    assert.equal(definition.target.remotePort, 61208);
    assert.equal(definition.target.stripPrefix, false);
    assert.equal(definition.target.redirectToSlash, true);
    assert.match(definition.target.htmlHead ?? "", /dbx-tools-glances-viewport/);
    assert.match(definition.target.htmlHead ?? "", /100svh/);
    assert.match(definition.target.htmlHead ?? "", /#processlist\{height:auto!important/);
    assert.equal(definition.target.openUrl, "/sandbox/metrics/machine/");
  });

  it("materializes packaged mise through the generic runner", async () => {
    let command = "";
    let args: string[] = [];
    let environment: Readonly<Record<string, string>> | undefined;
    const session = {
      execute: (
        value: string,
        values: string[],
        options: { env?: Readonly<Record<string, string>> },
      ) => {
        command = value;
        args = values;
        environment = options.env;
        return completedSshCommand(value, values, success);
      },
    } as unknown as SshSession;

    const target = await ensureSshService(session, "terminal", "/sandbox/terminal/machine", 1_000);

    assert.equal(command, "sh");
    assert.equal(args[0], "-lc");
    const encodedRunner = args[1]?.match(/^printf %s '([^']+)'/)?.[1];
    assert.ok(encodedRunner);
    const runner = Buffer.from(encodedRunner, "base64").toString("utf8");
    assert.match(
      runner,
      /service_directory="\$HOME\/projects\/\.sandbox-services\/\$service_kind"/,
    );
    assert.match(runner, /"\$mise_bin" install/);
    assert.match(runner, /\.dbx-tools\/operations\/services/);
    assert.match(runner, /lifecycle\.lock/);
    assert.match(runner, /lifecycle\.log/);
    assert.match(runner, /lifecycle\.status/);
    assert.match(runner, /maximum_attempts=2/);
    assert.match(runner, /__DBX_TOOLS_ATTEMPT__/);
    assert.match(runner, /__DBX_TOOLS_RESULT__/);
    assert.match(runner, /\.dbx-tools-install\.sha256/);
    assert.match(runner, /runner_version=3/);
    assert.match(runner, /if \[ "\$task" = start \]; then/);
    assert.doesNotMatch(runner, /\[ "\$task" = start \] && \[ "\$install" = true \]/);
    assert.match(runner, /"\$mise_bin" run "\$task"/);
    assert.equal(environment?.DBX_TOOLS_SERVICE_PATH, "/sandbox/terminal/machine");
    assert.equal(target.remotePort, 7681);
  });

  it("reads durable remote service and project states", async () => {
    let script = "";
    const session = {
      execute: (command: string, args: string[]) => {
        script = args[1] ?? "";
        return completedSshCommand(command, args, {
          ...success,
          stdout:
            "service\tterminal\tstarting\nservice-log\tterminal\taW5zdGFsbGluZyB0dHlkCg==\nservice\tdesktop\tready\nproject\tdemo/app\terror\nproject-log\tdemo/app\taW5zdGFsbCBmYWlsZWQK\n",
        });
      },
    } as unknown as SshSession;

    const states = await inspectSshLifecycleStates(session, 1_000);

    assert.equal(states.services.get("terminal"), "starting");
    assert.equal(states.serviceLogs.get("terminal"), "installing ttyd\n");
    assert.equal(states.services.get("desktop"), "ready");
    assert.equal(states.projects.get("demo/app"), "error");
    assert.equal(states.projectLogs.get("demo/app"), "install failed\n");
    assert.match(script, / '200' '16000'$/);
  });

  it("bounds lifecycle logs included in machine state inspection", async () => {
    const source = await readFile(new URL("../scripts/inspect-status.sh", import.meta.url), "utf8");

    assert.match(source, /tail -n "\$maximum_log_lines"/);
    assert.match(source, /tail -c "\$maximum_log_chars"/);
    assert.match(source, /timeout --signal=KILL 3 "\$mise_bin" run status/);
    assert.match(source, /printf '%s\\n' "\$state" >"\$operation_directory\/lifecycle\.status"/);
    assert.match(source, /printf 'project-log\\t%s\\t%s\\n'/);
  });

  it("reads the shared remote service operation log", async () => {
    let script = "";
    const session = {
      execute: (command: string, args: string[]) => {
        script = args[1] ?? "";
        return completedSshCommand(command, args, {
          ...success,
          stdout: "__DBX_TOOLS_ATTEMPT__=1\ninstalling ttyd\n",
        });
      },
    } as unknown as SshSession;

    assert.equal(
      await readSshServiceOperationLog(session, "terminal", 1_000),
      "__DBX_TOOLS_ATTEMPT__=1\ninstalling ttyd\n",
    );
    assert.match(script, /tail -n 200/);
    assert.match(script, /tail -c 16000/);
  });

  it("keeps remote provisioning shell out of TypeScript", async () => {
    const [servicesSource, desktopSource] = await Promise.all([
      readFile(new URL("../src/services.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/desktop.ts", import.meta.url), "utf8"),
    ]);
    for (const source of [servicesSource, desktopSource]) {
      assert.doesNotMatch(source, /apt-get|kasmvncserver :|nohup "\$|python3 - <<'PY'/);
    }
  });

  it("opens ttyd in the requested project directory", () => {
    assert.equal(
      projectTerminalOpenUrl("/sandbox/terminal/machine/", "/home/sandbox/projects/demo directory"),
      "/sandbox/terminal/machine/?arg=%2Fhome%2Fsandbox%2Fprojects%2Fdemo+directory",
    );
  });
});
