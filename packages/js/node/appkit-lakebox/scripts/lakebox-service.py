#!/usr/bin/env python3
"""Package-owned Lakebox service controller.

Runs as one locked Lakebox user. Owns the direct-crun lifecycle for that
user's services: saved definitions, image preparation through Buildah,
OCI spec generation, idempotent start and stop, readiness, bounded logs, and
restoring saved services after a Lakebox start.

Commands print one JSON document on stdout. Diagnostics go to service logs.
"""

import base64
import contextlib
import fcntl
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

RUNTIME = "/home/sandbox-agent/.dbx-tools/runtime"
BUNDLE = f"{RUNTIME}/container-v1/root"
POLICY = f"{BUNDLE}/etc/containers/policy.json"
HOME = os.environ["HOME"]
UID = os.getuid()
USER_HASH = os.path.basename(os.path.realpath(HOME))
SERVICES = f"{HOME}/.dbx-tools/services"
STORAGE = f"{HOME}/.dbx-tools/containers"
RUN = f"/run/lakebox/{USER_HASH}"
CRUN_ROOT = f"{RUN}/crun"
LOG_LIMIT = 1_048_576
LOG_KEEP = 262_144
HOST_BINDS = ("/usr", "/etc", "/opt", "/var", RUNTIME)


def runtime_env():
    return {
        "HOME": HOME,
        "USER": os.environ.get("USER", ""),
        "LOGNAME": os.environ.get("USER", ""),
        "XDG_RUNTIME_DIR": RUN,
        "PATH": f"{BUNDLE}/usr/bin:{BUNDLE}/usr/sbin:/usr/local/bin:/usr/bin:/bin",
        "LD_LIBRARY_PATH": f"{BUNDLE}/usr/lib/x86_64-linux-gnu:{BUNDLE}/lib/x86_64-linux-gnu"
        f":{BUNDLE}/usr/lib/aarch64-linux-gnu:{BUNDLE}/lib/aarch64-linux-gnu",
        "CONTAINERS_CONF": f"{BUNDLE}/usr/share/containers/containers.conf",
        "CONTAINERS_REGISTRIES_CONF": f"{BUNDLE}/etc/containers/registries.conf",
        "CONTAINERS_STORAGE_CONF": f"{STORAGE}/storage.conf",
        "BUILDAH_ISOLATION": "chroot",
    }


def namespaced(args, log=None, check=True, capture=False):
    """Runs one runtime command inside the user's single-UID namespace."""
    sink = log if log is not None else subprocess.DEVNULL
    result = subprocess.run(
        ["unshare", "-Ur", "-m", "--", *args],
        env=runtime_env(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else sink,
        stderr=sink,
        text=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} exited {result.returncode}")
    return result


def service_dir(name):
    return f"{SERVICES}/{name}"


def read_definition(name):
    with open(f"{service_dir(name)}/service.json", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, value):
    temporary = f"{path}.tmp.{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=1)
    os.replace(temporary, path)


@contextlib.contextmanager
def locked(name):
    os.makedirs(service_dir(name), mode=0o700, exist_ok=True)
    with open(f"{service_dir(name)}/.lock", "w", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def open_log(name):
    path = f"{service_dir(name)}/service.log"
    if os.path.exists(path) and os.path.getsize(path) > LOG_LIMIT:
        with open(path, "rb") as handle:
            handle.seek(-LOG_KEEP, os.SEEK_END)
            tail = handle.read()
        with open(path, "wb") as handle:
            handle.write(tail)
    return open(path, "a", encoding="utf-8")


def crun_state(name):
    result = namespaced(["crun", "--root", CRUN_ROOT, "state", container_id(name)], check=False, capture=True)
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout).get("status")
    except json.JSONDecodeError:
        return None


def container_id(name):
    return f"lakebox-{USER_HASH}-{name}"


def listening_sockets():
    """Yields (port, uid) for every listening TCP socket."""
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        if not os.path.exists(table):
            continue
        with open(table, encoding="utf-8") as handle:
            rows = [line.split() for line in handle.readlines()[1:]]
        for fields in rows:
            if fields[3] == "0A":
                yield int(fields[1].split(":")[1], 16), int(fields[7])


def listener_owner(port):
    """Returns the UID listening on a loopback TCP port, or None."""
    return next((uid for listening, uid in listening_sockets() if listening == port), None)


def port_open(port):
    with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", port), timeout=0.5):
        return True
    return False


def ensure_storage():
    os.makedirs(f"{STORAGE}/storage", mode=0o700, exist_ok=True)
    os.makedirs(CRUN_ROOT, mode=0o700, exist_ok=True)
    conf = f"{STORAGE}/storage.conf"
    content = (
        '[storage]\ndriver = "vfs"\n'
        f'runroot = "{RUN}/storage"\ngraphroot = "{STORAGE}/storage"\n'
        '[storage.options.vfs]\nignore_chown_errors = "true"\n'
    )
    existing = None
    with contextlib.suppress(FileNotFoundError), open(conf, encoding="utf-8") as handle:
        existing = handle.read()
    if existing != content:
        with open(conf, "w", encoding="utf-8") as handle:
            handle.write(content)


def prepare_image(definition, log):
    """Pulls the image when needed and returns the rootfs plus image config."""
    ensure_storage()
    image = definition["image"]
    working = f"lakebox-{definition['name']}"
    if definition.get("pull") == "always":
        namespaced(["buildah", "--signature-policy", POLICY, "pull", image], log)
    marker = f"{service_dir(definition['name'])}/image.json"
    previous = {}
    if os.path.exists(marker):
        with open(marker, encoding="utf-8") as handle:
            previous = json.load(handle)
    if previous.get("image") != image or definition.get("pull") == "always":
        namespaced(["buildah", "rm", working], check=False)
        log.write(f"preparing {image}\n")
        log.flush()
        namespaced(["buildah", "--signature-policy", POLICY, "from", "--name", working, image], log)
    rootfs = namespaced(["buildah", "mount", working], log, capture=True).stdout.strip()
    inspected = namespaced(["buildah", "inspect", "--type", "container", working], log, capture=True)
    config = json.loads(inspected.stdout).get("OCIv1", {}).get("config", {})
    write_json(marker, {"image": image})
    return rootfs, config


def prepare_host_rootfs(name):
    root = f"{service_dir(name)}/rootfs"
    for directory in ("usr", "etc", "opt", "var", "home", "run", "tmp", "proc", "sys", "dev", "root"):
        os.makedirs(f"{root}/{directory}", exist_ok=True)
    for link in ("bin", "sbin", "lib", "lib64"):
        if not os.path.lexists(f"{root}/{link}"):
            os.symlink(f"usr/{link}", f"{root}/{link}")
    for target in (HOME, RUNTIME):
        os.makedirs(f"{root}{target}", exist_ok=True)
    return root


def bind(source, target, read_only=True):
    options = ["rbind", "ro" if read_only else "rw"]
    return {"destination": target, "type": "bind", "source": source, "options": options}


def service_environment(definition, image_config, host):
    environment = dict(item.split("=", 1) for item in image_config.get("Env") or [] if "=" in item)
    environment.setdefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    if host:
        user = os.environ.get("USER", "")
        environment.update(HOME=HOME, USER=user, LOGNAME=user, SHELL="/bin/bash", LANG="C.UTF-8")
    environment["TERM"] = "xterm-256color"
    environment.update(definition.get("env") or {})
    return [f"{key}={value}" for key, value in environment.items()]


def service_command(definition, image_config):
    command = definition.get("command") or [
        *(image_config.get("Entrypoint") or []),
        *(image_config.get("Cmd") or []),
    ]
    if not command:
        raise RuntimeError("The image defines no entrypoint or command; set command")
    return command


def service_mounts(defaults, definition, host):
    """Keeps the default device mounts, binds /proc and /sys, and adds service mounts."""
    mounts = [entry for entry in defaults if entry["destination"] not in ("/proc", "/sys")]
    for entry in mounts:
        if entry["destination"] == "/dev/pts":
            entry["options"] = [option for option in entry["options"] if not option.startswith("gid=")]
    mounts.append({"destination": "/proc", "type": "bind", "source": "/proc",
                   "options": ["rbind", "nosuid", "nodev", "noexec"]})
    mounts.append(bind("/sys", "/sys"))
    if host:
        mounts.extend(bind(path, path) for path in HOST_BINDS)
        mounts.append(bind(HOME, HOME, read_only=False))
        mounts.append({"destination": "/tmp", "type": "tmpfs", "source": "tmpfs",
                       "options": ["nosuid", "nodev", "mode=1777"]})
    else:
        mounts.extend(bind(path, path) for path in ("/etc/resolv.conf", "/etc/hosts"))
    for mount in definition.get("mounts") or []:
        os.makedirs(mount["source"], exist_ok=True)
        mounts.append(bind(mount["source"], mount["target"], mount.get("readOnly", False)))
    return mounts


def apply_namespaces(linux, process, host):
    """Drops network, cgroup, and UTS namespaces; host services map the real UID."""
    namespaces = [entry for entry in linux["namespaces"] if entry["type"] not in ("network", "cgroup", "uts")]
    if host:
        namespaces.append({"type": "user"})
        linux["uidMappings"] = [{"containerID": UID, "hostID": 0, "size": 1}]
        linux["gidMappings"] = [{"containerID": UID, "hostID": 0, "size": 1}]
        process["user"] = {"uid": UID, "gid": UID}
    linux["namespaces"] = namespaces
    linux.pop("cgroupsPath", None)
    linux.pop("resources", None)


def oci_config(definition, rootfs, image_config):
    """Writes the OCI spec validated on FEVM for one service."""
    directory = service_dir(definition["name"])
    subprocess.run(["crun", "spec"], cwd=directory, env=runtime_env(), check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(f"{directory}/config.json", encoding="utf-8") as handle:
        config = json.load(handle)
    host = definition["kind"] != "image"
    config.pop("hostname", None)
    config["root"] = {"path": rootfs, "readonly": host}
    config["process"].update(
        args=service_command(definition, image_config),
        terminal=False,
        env=service_environment(definition, image_config, host),
        cwd=definition.get("workingDirectory") or (HOME if host else image_config.get("WorkingDir") or "/"),
    )
    apply_namespaces(config["linux"], config["process"], host)
    config["mounts"] = service_mounts(config["mounts"], definition, host)
    write_json(f"{directory}/config.json", config)


def wait_ready(definition, log, deadline):
    port = definition["port"]
    name = definition["name"]
    while time.time() < deadline:
        if crun_state(name) not in ("running", "created"):
            raise RuntimeError("The service process exited; see the service log")
        if definition.get("readiness", "tcp") == "none":
            return
        owner = listener_owner(port)
        if owner is not None and owner != UID:
            raise RuntimeError(f"Port {port} is held by another account")
        if owner == UID and port_open(port):
            return
        time.sleep(0.5)
    raise RuntimeError(f"The service did not listen on 127.0.0.1:{port} in time")


def stop_container(name, grace=10):
    cid = container_id(name)
    if crun_state(name) == "running":
        namespaced(["crun", "--root", CRUN_ROOT, "kill", cid, "TERM"], check=False)
        deadline = time.time() + grace
        while time.time() < deadline and crun_state(name) == "running":
            time.sleep(0.25)
        namespaced(["crun", "--root", CRUN_ROOT, "kill", cid, "KILL"], check=False)
    namespaced(["crun", "--root", CRUN_ROOT, "delete", "--force", cid], check=False)


def write_status(name, state, error=None):
    status = {"state": state, "updatedAt": time.time()}
    if error:
        status["error"] = error
    write_json(f"{service_dir(name)}/status.json", status)


def already_ready(definition):
    if crun_state(definition["name"]) != "running":
        return False
    return definition.get("readiness", "tcp") == "none" or listener_owner(definition["port"]) == UID


def launch(definition, log):
    """Recreates the container from its definition and waits for readiness."""
    name = definition["name"]
    stop_container(name)
    if listener_owner(definition["port"]) is not None:
        raise RuntimeError(f"Port {definition['port']} is already in use")
    if definition["kind"] == "image":
        rootfs, image_config = prepare_image(definition, log)
    else:
        rootfs, image_config = prepare_host_rootfs(name), {}
    oci_config(definition, rootfs, image_config)
    namespaced(["crun", "--root", CRUN_ROOT, "create", "--bundle", service_dir(name), container_id(name)], log)
    namespaced(["crun", "--root", CRUN_ROOT, "start", container_id(name)], log)
    wait_ready(definition, log, time.time() + definition.get("readySeconds", 180))


def start(name):
    with locked(name):
        definition = read_definition(name)
        if already_ready(definition):
            write_status(name, "ready")
            return describe(name)
        write_status(name, "starting")
        with open_log(name) as log:
            log.write(f"--- start {time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
            log.flush()
            try:
                launch(definition, log)
            except (OSError, RuntimeError, ValueError, KeyError) as error:
                log.write(f"--- error: {error}\n")
                write_status(name, "error", str(error))
                return describe(name)
            write_status(name, "ready")
            log.write("--- ready\n")
    return describe(name)


def stop(name):
    with locked(name):
        stop_container(name)
        write_status(name, "stopped")
    return describe(name)


def remove(name):
    if not os.path.isdir(service_dir(name)):
        return {"removed": False}
    with locked(name):
        stop_container(name)
        namespaced(["buildah", "rm", f"lakebox-{name}"], check=False)
    shutil.rmtree(service_dir(name), ignore_errors=True)
    return {"removed": True}


def read_status(name):
    status = {}
    with (
        contextlib.suppress(FileNotFoundError, json.JSONDecodeError),
        open(f"{service_dir(name)}/status.json", encoding="utf-8") as handle,
    ):
        status = json.load(handle)
    return status


def resolve_service_state(status, running, lock_is_held):
    state = status.get("state", "stopped")
    if state == "ready" and not running:
        return "stopped"
    if state == "starting" and not running and not lock_is_held:
        return "error" if status.get("error") else "stopped"
    return state


def describe(name, include_log=False):
    definition = read_definition(name)
    status = read_status(name)
    running = crun_state(name) == "running"
    lock_is_held = lock_held(name) if status.get("state") == "starting" and not running else False
    state = resolve_service_state(status, running, lock_is_held)
    result = {"name": name, "state": state, "definition": definition}
    if status.get("error") and state == "error":
        result["error"] = status["error"]
    if include_log:
        result["log"] = tail(name, 200, 16_000)
    return result


def lock_held(name):
    with (
        contextlib.suppress(FileNotFoundError),
        open(f"{service_dir(name)}/.lock", "w", encoding="utf-8") as handle,
    ):
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def names():
    if not os.path.isdir(SERVICES):
        return []
    return sorted(
        entry for entry in os.listdir(SERVICES) if os.path.exists(f"{service_dir(entry)}/service.json")
    )


def tail(name, max_lines, max_chars):
    path = f"{service_dir(name)}/service.log"
    if not os.path.exists(path):
        return ""
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - max_chars * 4))
        text = handle.read().decode("utf-8", errors="replace")
    return "\n".join(text.splitlines()[-max_lines:])[-max_chars:]


def put_command(encoded_definition):
    definition = json.loads(base64.b64decode(encoded_definition))
    name = definition["name"]
    with locked(name):
        write_json(f"{service_dir(name)}/service.json", definition)
    return describe(name)


def list_command():
    return {"services": [describe(name, include_log=True) for name in names()]}


def logs_command(name, max_lines, max_chars):
    return {"log": tail(name, int(max_lines), int(max_chars))}


def start_all_command():
    return {"services": [start(name) for name in names() if read_definition(name).get("autostart")]}


COMMANDS = {
    "put": put_command,
    "start": start,
    "stop": stop,
    "remove": remove,
    "list": list_command,
    "logs": logs_command,
    "start-all": start_all_command,
}


def usage():
    print(f"usage: lakebox-service {'|'.join(COMMANDS)}", file=sys.stderr)
    raise SystemExit(2)


def dispatch(command, args):
    handler = COMMANDS.get(command)
    if handler is None:
        usage()
    return handler(*args)


def main():
    if len(sys.argv) < 2:
        usage()
    json.dump(dispatch(sys.argv[1], sys.argv[2:]), sys.stdout)


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    main()
