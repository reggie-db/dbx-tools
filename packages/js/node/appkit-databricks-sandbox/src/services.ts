import type { SshCommandResult, SshMachineServiceKind } from "@dbx-tools/shared-databricks-sandbox";
import type { SshSession } from "./session.ts";

const DINOTTY_VERSION = "0.29.0";
const GLANCES_VERSION = "4.5.6";
const DINOTTY_PORT = 7681;
const GLANCES_PORT = 61208;
const DINOTTY_RELAY_HEAD = `<style id="dbx-tools-dinotty-relay">
.status-bar-server-wrap{display:none!important}
</style>`;
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
  remoteHost: string;
  remotePort: number;
  stripPrefix: boolean;
  browserPaths?: string[];
  browserRelay?: boolean;
  redirectToSlash?: boolean;
  htmlHead?: string;
}

/** Starts an idempotent built-in browser service on an SSH machine. */
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
  return kind === "terminal"
    ? {
        remoteHost: "127.0.0.1",
        remotePort: DINOTTY_PORT,
        stripPrefix: true,
        browserRelay: true,
        browserPaths: [
          "/assets",
          "/icons",
          "/manifest.json",
          "/logo.png",
          "/preview",
          "/mcp",
        ],
        htmlHead: DINOTTY_RELAY_HEAD,
      }
    : {
        remoteHost: "127.0.0.1",
        remotePort: GLANCES_PORT,
        stripPrefix: false,
        redirectToSlash: true,
        htmlHead: GLANCES_VIEWPORT_HEAD,
      };
}

function assertServiceStarted(kind: SshMachineServiceKind, result: SshCommandResult): void {
  if (result.success) return;
  throw new Error(
    result.stderr.trim() || result.stdout.trim() || `${kind} service exited ${result.exitCode}`,
  );
}

function serviceScript(kind: SshMachineServiceKind, path: string): string {
  return kind === "terminal" ? dinottyScript() : glancesScript(path);
}

function dinottyScript(): string {
  return `set -euo pipefail
runtime="$HOME/.dbx-tools/runtime"
bin="$runtime/bin/dinotty-server"
pid_file="$runtime/dinotty.pid"
log_file="$runtime/dinotty.log"
version_file="$runtime/dinotty.version"
mkdir -p "$runtime/bin" "$HOME/.config/dinotty"
if [ ! -x "$bin" ] || [ ! -f "$version_file" ] || [ "$(cat "$version_file")" != "${DINOTTY_VERSION}" ]; then
  if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    kill "$(cat "$pid_file")"
    for _ in $(seq 1 40); do
      kill -0 "$(cat "$pid_file")" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$pid_file"
  DINOTTY_VERSION=${DINOTTY_VERSION} DINOTTY_DESTINATION="$bin" python3 - <<'PY'
import io
import os
import platform
import stat
import tarfile
import urllib.request
from pathlib import Path

version = os.environ["DINOTTY_VERSION"]
architectures = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64"}
architecture = architectures.get(platform.machine().lower())
if architecture is None:
    raise RuntimeError(f"Unsupported DinoTTY architecture: {platform.machine()}")
url = f"https://github.com/xichan96/dinotty/releases/download/v{version}/dinotty-server_{version}-1_{architecture}.deb"
with urllib.request.urlopen(url) as response:
    package = response.read()
if package[:8] != b"!<arch>\\n":
    raise RuntimeError("DinoTTY package is not a Debian archive")
offset = 8
payload = None
while offset + 60 <= len(package):
    header = package[offset:offset + 60]
    name = header[:16].decode("ascii").strip().rstrip("/")
    size = int(header[48:58].decode("ascii").strip())
    offset += 60
    member = package[offset:offset + size]
    offset += size + (size % 2)
    if name.startswith("data.tar"):
        payload = member
        break
if payload is None:
    raise RuntimeError("DinoTTY package has no data archive")
destination = Path(os.environ["DINOTTY_DESTINATION"])
with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
    source = archive.extractfile(archive.getmember("./usr/bin/dinotty-server"))
    if source is None:
        raise RuntimeError("DinoTTY binary is missing")
    temporary = destination.with_suffix(".tmp")
    temporary.write_bytes(source.read())
    temporary.chmod(temporary.stat().st_mode | stat.S_IXUSR)
    os.replace(temporary, destination)
PY
  printf '%s\n' "${DINOTTY_VERSION}" >"$version_file"
fi
python3 - <<'PY'
import json
from pathlib import Path

path = Path.home() / ".config" / "dinotty" / "settings.json"
try:
    settings = json.loads(path.read_text())
except (FileNotFoundError, json.JSONDecodeError):
    settings = {}
settings.setdefault("open_api", {})["enabled"] = True
settings.setdefault("mcp", {}).update({"http_enabled": True, "stdio_enabled": True})
settings["ip_whitelist"] = ["127.0.0.1", "::1"]
path.write_text(json.dumps(settings, indent=2) + "\\n")
PY
if ! [ -s "$pid_file" ] || ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  nohup env DINOTTY_SHELL="$(command -v bash)" DINOTTY_TOKEN="databricks-app-oauth" \
    "$bin" --port ${DINOTTY_PORT} >"$log_file" 2>&1 </dev/null &
  echo $! >"$pid_file"
fi
python3 - ${DINOTTY_PORT} <<'PY'
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
raise SystemExit("DinoTTY did not become ready")
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
