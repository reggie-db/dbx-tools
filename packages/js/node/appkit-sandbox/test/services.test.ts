import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brandUtils } from "@dbx-tools/shared-core";
import type { SshCommandResult } from "@dbx-tools/shared-databricks-sandbox";
import { dbxToolsAssetSvg } from "@dbx-tools/ui/branding/assets";
import { ensureSshService, projectTerminalOpenUrl } from "../src/services.ts";
import type { SshSession } from "../src/session.ts";

const success: SshCommandResult = {
  command: "bash",
  args: ["-lc"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  success: true,
  durationMs: 1,
};

describe("ensureSshService", () => {
  it("installs pinned ttyd and serves it beneath the public route path", async () => {
    let script = "";
    const session = {
      execute: async (_command: string, args: string[]) => {
        script = args[1] ?? "";
        return success;
      },
    } as unknown as SshSession;

    const target = await ensureSshService(session, "terminal", "/sandbox/terminal/machine", 1_000);

    assert.match(script, /TTYD_VERSION=1\.7\.7/);
    assert.match(script, /ttyd\.version/);
    assert.match(script, /aarch64\) checksum=b38acadd/);
    assert.match(script, /x86_64\) checksum=8a217c96/);
    assert.match(script, /releases\/download\/\{version\}\/ttyd\.\{architecture\}/);
    assert.match(script, /ttyd checksum mismatch/);
    assert.match(script, /dbx-tools-shell/);
    assert.match(script, /dbx-tools-bashrc/);
    assert.match(script, /unset BASH_ENV ENV PROMPT_COMMAND/);
    assert.match(script, /--noprofile --rcfile/);
    assert.doesNotMatch(script, /bash -i -l/);
    assert.match(script, /--writable --url-arg/);
    assert.match(script, /--interface 127\.0\.0\.1/);
    assert.match(script, /--client-option rendererType=webgl/);
    assert.match(script, /legacy_pid_file="\$runtime\/dinotty\.pid"/);
    assert.match(script, /kill "\$\(cat "\$file"\)"/);
    assert.equal(target.stripPrefix, true);
    assert.equal(target.redirectToSlash, true);
    assert.equal(target.openUrl, "/sandbox/terminal/machine/");
  });

  it("provisions the branded loopback desktop idempotently", async () => {
    let script = "";
    const session = {
      execute: async (_command: string, args: string[]) => {
        script = args[1] ?? "";
        return success;
      },
    } as unknown as SshSession;

    const target = await ensureSshService(session, "desktop", "/sandbox/desktop/machine", 1_000);

    assert.match(script, /noble-amd64\) package_checksum=/);
    assert.match(script, /package_name="kasmvncserver_\$\{codename\}_1\.5\.0_\$architecture\.deb"/);
    assert.match(script, /f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e/);
    assert.match(script, /kasmvncserver :20 -fg/);
    assert.match(script, /-select-de xfce -xstartup/);
    assert.match(script, /-websocketPort 6080/);
    assert.match(script, /-disableBasicAuth -SecurityTypes None/);
    assert.match(script, /allow_resize: true/);
    assert.match(script, /pem_certificate:\n    pem_key:\n    require_ssl: false/);
    assert.match(script, /video_streaming_mode:\n    codec: h264/);
    assert.match(script, /enter_video_encoding_mode:\n      time_threshold: 1/);
    assert.match(script, /Cross-Origin-Embedder-Policy=require-corp/);
    assert.match(script, /Cross-Origin-Opener-Policy=same-origin/);
    assert.doesNotMatch(script, /tigervnc-standalone-server|websockify --web|\/usr\/share\/novnc/);
    assert.match(script, /dbx-tools-wallpaper\.svg/);
    assert.match(script, /epiphany-browser/);
    assert.match(script, /WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1/);
    assert.match(script, /dbx-tools-browser\.desktop/);
    assert.match(script, /WebBrowser=dbx-tools-browser/);
    assert.match(script, /gsettings set org\.gnome\.Epiphany homepage-url/);
    assert.match(script, /browser-homepage/);
    const encodedHomepage = script.match(
      /printf %s '([^']+)' \| base64 -d >"\$browser_homepage"/,
    )?.[1];
    assert.ok(encodedHomepage);
    assert.equal(
      Buffer.from(encodedHomepage, "base64").toString("utf8"),
      brandUtils.defaultBrandContext.links.website,
    );
    assert.match(script, /rm -f "\$HOME\/Desktop\/Web Browser\.desktop"/);
    assert.doesNotMatch(script, /cat >"\$HOME\/Desktop\/Web Browser\.desktop"/);
    assert.match(script, /desktop_environment="\$runtime\/environment"/);
    assert.match(script, /desktop_runner="\$runtime\/run"/);
    assert.match(script, /printf 'export DISPLAY=:%s\\n' '20'/);
    assert.match(script, /\. "\$HOME\/\.dbx-tools\/runtime\/desktop\/environment"/);
    assert.match(script, /exec "\$@"/);
    assert.doesNotMatch(script, /ls \/tmp\/\.X11-unix|sed .*DISPLAY/);
    assert.match(script, /dbx-tools-terminal\.desktop/);
    assert.match(script, /Icon=\$terminal_icon/);
    assert.match(script, /rm -f "\$HOME\/Desktop\/Terminal\.desktop"/);
    assert.doesNotMatch(script, /cat >"\$HOME\/Desktop\/Terminal\.desktop"/);
    const encodedTerminalIcon = script.match(
      /printf %s '([^']+)' \| base64 -d >"\$terminal_icon_svg"/,
    )?.[1];
    assert.ok(encodedTerminalIcon);
    assert.match(Buffer.from(encodedTerminalIcon, "base64").toString("utf8"), /<svg/);
    assert.match(script, /arc-theme/);
    assert.match(script, /libavcodec-dev/);
    assert.match(script, /libavformat-dev/);
    assert.match(script, /libswscale-dev/);
    assert.match(script, /papirus-icon-theme/);
    assert.match(script, /xfce4-whiskermenu-plugin/);
    assert.match(script, /Arc-Dark/);
    assert.match(script, /Papirus-Dark/);
    assert.match(script, /button-title string 'dbx tools'/);
    assert.match(script, /xfce4-panel/);
    assert.match(script, /xfdesktop/);
    assert.match(script, /xfwm4/);
    assert.match(script, /exec dbus-run-session -- "\$0"/);
    assert.match(script, /startxfce4 >>"\$log_file"/);
    assert.match(script, /grep -E '\/\(last-image\|image-path\)\$'/);
    assert.match(script, /Xfce desktop session did not become ready/);
    assert.match(script, /urllib\.request\.urlopen/);
    assert.match(script, /KasmVNC web client did not become ready/);
    const encodedWallpaper = script.match(/printf %s '([^']+)' \| base64 -d/)?.[1];
    assert.ok(encodedWallpaper);
    const wallpaper = Buffer.from(encodedWallpaper, "base64").toString("utf8");
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
    assert.doesNotMatch(wallpaper, /M24 27h50v12/);
    assert.doesNotMatch(wallpaper, /BUILD · TEST · EXPLORE/);
    assert.match(script, /version_file/);
    assert.equal(target.remotePort, 6080);
    assert.equal(target.stripPrefix, true);
    assert.equal(target.redirectToSlash, true);
    assert.match(target.htmlHead ?? "", /dbx-tools-desktop-brand/);
    assert.match(target.htmlHead ?? "", /\.noVNC_logo[^}]*display:none!important/);
    assert.match(target.htmlHead ?? "", /KasmVNC Learn More/);
    assert.match(target.htmlHead ?? "", /document\.title="dbx tools Desktop"/);
    assert.match(target.htmlHead ?? "", /data:image\/svg\+xml;base64/);
    assert.equal(
      target.openUrl,
      "/sandbox/desktop/machine/?autoconnect=1&resize=remote&show_dot=1&clipboard_seamless=0&enable_webp=0&kasmvnc_mode_preference=-1027&path=sandbox%2Fdesktop%2Fmachine%2Fwebsockify",
    );
  });

  it("adds dynamic viewport sizing to the Glances document", async () => {
    const session = {
      execute: async () => success,
    } as unknown as SshSession;

    const target = await ensureSshService(session, "stats", "/sandbox/metrics/machine", 1_000);

    assert.equal(target.redirectToSlash, true);
    assert.match(target.htmlHead ?? "", /dbx-tools-glances-viewport/);
    assert.match(target.htmlHead ?? "", /100svh/);
    assert.match(target.htmlHead ?? "", /#processlist\{height:auto!important/);
    assert.match(target.htmlHead ?? "", /#processlist-table\{[^}]*overflow-x:auto/);
    assert.doesNotMatch(target.htmlHead ?? "", /table-layout:fixed/);
    assert.equal(target.openUrl, "/sandbox/metrics/machine/");
  });

  it("opens ttyd in the requested project directory", () => {
    assert.equal(
      projectTerminalOpenUrl(
        "/sandbox/terminal/machine/",
        "/home/sandbox/projects/demo directory",
      ),
      "/sandbox/terminal/machine/?arg=%2Fhome%2Fsandbox%2Fprojects%2Fdemo+directory",
    );
  });
});
