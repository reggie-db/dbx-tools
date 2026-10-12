import type { SshCommandResult, SshMachineServiceKind } from "@dbx-tools/shared-databricks-sandbox";
import { dbxToolsAssetDataUrls } from "@dbx-tools/ui/branding/assets";
import { desktopOpenUrl, desktopPorts, desktopScript } from "./desktop.ts";
import type { SshSession } from "./session.ts";

const TTYD_VERSION = "1.7.7";
const TTYD_CHECKSUMS = {
  aarch64: "b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165",
  x86_64: "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55",
} as const;
const GLANCES_VERSION = "4.5.6";
const TTYD_PORT = 7681;
const GLANCES_PORT = 61208;
const DESKTOP_BRAND_HEAD = `<style id="dbx-tools-desktop-brand">
.noVNC_logo,h1.noVNC_logo,a[title="KasmVNC Learn More"]{display:none!important}
</style>
<link data-dbx-tools-desktop-icon rel="icon" href="${dbxToolsAssetDataUrls.iconDark}">
<script id="dbx-tools-desktop-brand-script">(()=>{const icon=${JSON.stringify(dbxToolsAssetDataUrls.iconDark)};const rewrite=(root)=>{if(root.nodeType===Node.TEXT_NODE){if(root.nodeValue?.includes("KasmVNC"))root.nodeValue=root.nodeValue.replaceAll("KasmVNC","dbx tools Desktop");return}const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())if(node.nodeValue?.includes("KasmVNC"))node.nodeValue=node.nodeValue.replaceAll("KasmVNC","dbx tools Desktop")};const apply=()=>{document.title="dbx tools Desktop";for(const link of document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]'))link.setAttribute("href",icon);if(document.body)rewrite(document.body)};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",apply,{once:true});else apply();new MutationObserver((entries)=>{for(const entry of entries){if(entry.type==="characterData")rewrite(entry.target);else for(const node of entry.addedNodes)rewrite(node)}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true})})();</script>`;
const GLANCES_VIEWPORT_HEAD = `<style id="dbx-tools-glances-viewport">
html,body,#app{width:100%;max-width:100vw;height:100%;height:100svh;max-height:100svh;min-height:0;overflow:hidden}
body{position:fixed;inset:0;margin:0}
#app>main{display:flex;width:100%;max-width:100vw;height:100%;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
.top,.bottom,.bottom>.row,.bottom .col{max-width:100%;min-width:0}
.bottom{min-height:0;flex:1;overflow:hidden}.bottom>.row{height:100%;min-height:0;margin-right:0;margin-left:0}.bottom .col{height:100%;min-height:0;padding-right:0;padding-left:0;overflow-x:hidden;overflow-y:auto}
.sidebar-min,.sidebar-max{height:100%!important;min-height:0!important}
#processlist{height:auto!important;max-width:100%;overflow:visible}
#processlist-table{width:100%;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
</style>`;

/** Loopback service endpoint and routing behavior discovered after remote startup. */
export interface SshServiceTarget {
  /** Remote loopback host. */
  remoteHost: string;
  /** Remote service port. */
  remotePort: number;
  /** Whether AppKit removes the public route prefix before forwarding. */
  stripPrefix: boolean;
  /** Whether requests without a trailing slash redirect before forwarding. */
  redirectToSlash?: boolean;
  /** Optional markup injected into proxied HTML heads. */
  htmlHead?: string;
  /** AppKit URL that opens the service at its intended entry page. */
  openUrl: string;
}

/**
 * Starts an idempotent built-in browser service on an SSH machine.
 *
 * Repeated calls reuse the service's stable runtime files and return the
 * loopback target that {@link SshRouteRegistry} publishes through AppKit.
 *
 * @throws When the remote startup command exits unsuccessfully.
 */
export async function ensureSshService(
  session: SshSession,
  kind: SshMachineServiceKind,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SshServiceTarget> {
  const result = await session.execute("bash", ["-lc", serviceScript(kind, path)], {
    timeoutMs,
    signal,
  });
  assertServiceStarted(kind, result);
  if (kind === "terminal") {
    return {
      remoteHost: "127.0.0.1",
      remotePort: TTYD_PORT,
      stripPrefix: true,
      redirectToSlash: true,
      openUrl: `${path.replace(/\/+$/, "")}/`,
    };
  }
  if (kind === "desktop") {
    return {
      remoteHost: "127.0.0.1",
      remotePort: desktopPorts.web,
      stripPrefix: true,
      redirectToSlash: true,
      htmlHead: DESKTOP_BRAND_HEAD,
      openUrl: desktopOpenUrl(path),
    };
  }
  return {
    remoteHost: "127.0.0.1",
    remotePort: GLANCES_PORT,
    stripPrefix: false,
    redirectToSlash: true,
    htmlHead: GLANCES_VIEWPORT_HEAD,
    openUrl: `${path.replace(/\/+$/, "")}/`,
  };
}

/** Return a ttyd URL that starts the shell in one owned project directory. */
export function projectTerminalOpenUrl(openUrl: string, directory: string): string {
  const url = new URL(openUrl, "http://localhost");
  url.searchParams.set("arg", directory);
  return `${url.pathname}${url.search}`;
}

function assertServiceStarted(kind: SshMachineServiceKind, result: SshCommandResult): void {
  if (result.success) return;
  throw new Error(
    result.stderr.trim() || result.stdout.trim() || `${kind} service exited ${result.exitCode}`,
  );
}

function serviceScript(kind: SshMachineServiceKind, path: string): string {
  if (kind === "terminal") return ttydScript();
  if (kind === "desktop") return desktopScript();
  return glancesScript(path);
}

function ttydScript(): string {
  const checksums = Object.entries(TTYD_CHECKSUMS)
    .map(([architecture, checksum]) => `  ${architecture}) checksum=${checksum} ;;`)
    .join("\n");
  return `set -euo pipefail
runtime="$HOME/.dbx-tools/runtime"
bin="$runtime/bin/ttyd"
pid_file="$runtime/ttyd.pid"
legacy_pid_file="$runtime/dinotty.pid"
log_file="$runtime/ttyd.log"
version_file="$runtime/ttyd.version"
shell_wrapper="$runtime/bin/dbx-tools-shell"
bashrc="$runtime/bin/dbx-tools-bashrc"
mkdir -p "$runtime/bin"
stop_pid() {
  file="$1"
  if [ -s "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
    kill "$(cat "$file")"
    for _ in $(seq 1 40); do
      kill -0 "$(cat "$file")" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$file"
}
stop_pid "$legacy_pid_file"
if [ ! -x "$bin" ] || [ ! -f "$version_file" ] || [ "$(cat "$version_file")" != "${TTYD_VERSION}" ]; then
  stop_pid "$pid_file"
  case "$(uname -m)" in
${checksums}
    *) echo "Unsupported ttyd architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  TTYD_VERSION=${TTYD_VERSION} TTYD_ARCHITECTURE="$(uname -m)" TTYD_CHECKSUM="$checksum" TTYD_DESTINATION="$bin" python3 - <<'PY'
import hashlib
import os
import stat
import urllib.request
from pathlib import Path

version = os.environ["TTYD_VERSION"]
architecture = os.environ["TTYD_ARCHITECTURE"]
url = f"https://github.com/tsl0922/ttyd/releases/download/{version}/ttyd.{architecture}"
with urllib.request.urlopen(url) as response:
    payload = response.read()
if hashlib.sha256(payload).hexdigest() != os.environ["TTYD_CHECKSUM"]:
    raise RuntimeError("ttyd checksum mismatch")
destination = Path(os.environ["TTYD_DESTINATION"])
temporary = destination.with_suffix(".tmp")
temporary.write_bytes(payload)
temporary.chmod(temporary.stat().st_mode | stat.S_IXUSR)
os.replace(temporary, destination)
PY
  printf '%s\n' "${TTYD_VERSION}" >"$version_file"
fi
cat >"$bashrc" <<'EOF'
# Interactive ttyd rc: user bashrc without login motd, sudo hint, or export dumps.
if [ -f "\${HOME}/.bashrc" ]; then
  . "\${HOME}/.bashrc" >/dev/null 2>&1
fi
EOF
cat >"$shell_wrapper" <<'EOF'
#!/bin/sh
unset BASH_ENV ENV PROMPT_COMMAND
directory="\${1:-$HOME}"
case "$directory" in
  "$HOME"|"$HOME"/*) ;;
  *) directory="$HOME" ;;
esac
cd -- "$directory"
exec /bin/bash --noprofile --rcfile "\${HOME}/.dbx-tools/runtime/bin/dbx-tools-bashrc" -i
EOF
chmod 600 "$bashrc"
chmod 700 "$shell_wrapper"
if ! [ -s "$pid_file" ] || ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  nohup "$bin" --interface 127.0.0.1 --port ${TTYD_PORT} --writable --url-arg \
    --client-option term=xterm-256color --client-option rendererType=webgl \
    --client-option cursorStyle=bar --client-option copyOnSelect=true \
    --client-option rightClickSelectsWord=true --client-option disableLeaveAlert=true \
    --client-option disableResizeOverlay=true "$shell_wrapper" >"$log_file" 2>&1 </dev/null &
  echo $! >"$pid_file"
fi
python3 - ${TTYD_PORT} <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
for _ in range(120):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            raise SystemExit(0)
    except OSError:
        time.sleep(0.5)
raise SystemExit("ttyd did not become ready")
PY`;
}

function glancesScript(path: string): string {
  return `set -euo pipefail
runtime="$HOME/.dbx-tools/runtime"
venv="$runtime/glances"
pid_file="$runtime/glances.pid"
log_file="$runtime/glances.log"
config="$runtime/glances.conf"
mkdir -p "$runtime"
if [ ! -x "$venv/bin/glances" ] || [ ! -f "$venv/.version" ] || [ "$(cat "$venv/.version")" != "${GLANCES_VERSION}" ]; then
  rm -rf "$venv"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python python3 "$venv"
    uv pip install --python "$venv/bin/python" --no-cache "glances[web]==${GLANCES_VERSION}"
  else
    if ! python3 -m venv "$venv"; then
      sudo -n apt-get update
      sudo -n apt-get install -y python3-venv
      python3 -m venv "$venv"
    fi
    "$venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir "glances[web]==${GLANCES_VERSION}"
  fi
  printf '%s\\n' "${GLANCES_VERSION}" >"$venv/.version"
fi
cat >"$config" <<'EOF'
[global]
webui_allowed_hosts=127.0.0.1,localhost

[outputs]
url_prefix=${path}/
EOF
if ! [ -s "$pid_file" ] || ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  nohup "$venv/bin/glances" --config "$config" --webserver --bind 127.0.0.1 \
    --port ${GLANCES_PORT} --disable-autodiscover >"$log_file" 2>&1 </dev/null &
  echo $! >"$pid_file"
fi
python3 - ${GLANCES_PORT} <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
for _ in range(240):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            raise SystemExit(0)
    except OSError:
        time.sleep(0.5)
raise SystemExit("Glances did not become ready")
PY`;
}
