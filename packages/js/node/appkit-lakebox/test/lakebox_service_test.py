import copy
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

TEST_HOME = tempfile.TemporaryDirectory()
os.environ["HOME"] = TEST_HOME.name
SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "lakebox-service.py"
SPEC = importlib.util.spec_from_file_location("lakebox_service", SCRIPT)
CONTROLLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROLLER)


class LakeboxServiceTest(unittest.TestCase):
    def test_namespaced_commands_use_the_single_uid_mount_namespace(self):
        completed = mock.Mock(returncode=0)
        with mock.patch.object(CONTROLLER.subprocess, "run", return_value=completed) as run:
            self.assertIs(CONTROLLER.namespaced(["crun", "state"]), completed)
        self.assertEqual(
            run.call_args.args[0],
            ["unshare", "-Ur", "-m", "--", "crun", "state"],
        )
        self.assertFalse(run.call_args.kwargs["check"])

    def test_resolves_persisted_state_against_runtime_state(self):
        cases = (
            ({}, False, False, "stopped"),
            ({"state": "ready"}, True, False, "ready"),
            ({"state": "ready"}, False, False, "stopped"),
            ({"state": "starting"}, False, True, "starting"),
            ({"state": "starting"}, False, False, "stopped"),
            ({"state": "starting", "error": "failed"}, False, False, "error"),
        )
        for status, running, lock_is_held, expected in cases:
            with self.subTest(status=status, running=running, lock_is_held=lock_is_held):
                self.assertEqual(
                    CONTROLLER.resolve_service_state(status, running, lock_is_held),
                    expected,
                )

    def test_describe_reads_status_and_includes_error_and_log(self):
        definition = {"name": "site", "kind": "image", "port": 20000}
        with (
            mock.patch.object(CONTROLLER, "read_definition", return_value=definition),
            mock.patch.object(
                CONTROLLER,
                "read_status",
                return_value={"state": "starting", "error": "failed"},
            ),
            mock.patch.object(CONTROLLER, "crun_state", return_value=None),
            mock.patch.object(CONTROLLER, "lock_held", return_value=False),
            mock.patch.object(CONTROLLER, "tail", return_value="controller log"),
        ):
            self.assertEqual(
                CONTROLLER.describe("site", include_log=True),
                {
                    "name": "site",
                    "state": "error",
                    "definition": definition,
                    "error": "failed",
                    "log": "controller log",
                },
            )

    def test_host_namespace_policy_maps_only_the_service_user(self):
        linux = {
            "namespaces": [
                {"type": "pid"},
                {"type": "ipc"},
                {"type": "mount"},
                {"type": "network"},
                {"type": "cgroup"},
                {"type": "uts"},
            ],
            "cgroupsPath": "service",
            "resources": {"devices": []},
        }
        process = {"user": {"uid": 0, "gid": 0}}
        CONTROLLER.apply_namespaces(linux, process, host=True)
        self.assertEqual(
            [namespace["type"] for namespace in linux["namespaces"]],
            ["pid", "ipc", "mount", "user"],
        )
        self.assertEqual(
            linux["uidMappings"], [{"containerID": CONTROLLER.UID, "hostID": 0, "size": 1}]
        )
        self.assertEqual(
            linux["gidMappings"], [{"containerID": CONTROLLER.UID, "hostID": 0, "size": 1}]
        )
        self.assertEqual(process["user"], {"uid": CONTROLLER.UID, "gid": CONTROLLER.UID})
        self.assertNotIn("cgroupsPath", linux)
        self.assertNotIn("resources", linux)

    def test_mount_policy_keeps_host_binds_read_only_and_tmp_private(self):
        defaults = [
            {"destination": "/proc", "type": "proc", "source": "proc", "options": []},
            {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": []},
            {
                "destination": "/dev/pts",
                "type": "devpts",
                "source": "devpts",
                "options": ["nosuid", "gid=5"],
            },
        ]
        host_mounts = CONTROLLER.service_mounts(copy.deepcopy(defaults), {"mounts": []}, host=True)
        by_destination = {mount["destination"]: mount for mount in host_mounts}
        self.assertEqual(by_destination["/proc"]["source"], "/proc")
        self.assertEqual(by_destination["/sys"]["options"], ["rbind", "ro"])
        self.assertNotIn("gid=5", by_destination["/dev/pts"]["options"])
        self.assertEqual(by_destination[CONTROLLER.HOME]["options"], ["rbind", "rw"])
        self.assertEqual(by_destination["/tmp"]["type"], "tmpfs")
        for path in CONTROLLER.HOST_BINDS:
            self.assertEqual(by_destination[path]["options"], ["rbind", "ro"])

        image_mounts = CONTROLLER.service_mounts(
            copy.deepcopy(defaults), {"mounts": []}, host=False
        )
        image_destinations = {mount["destination"] for mount in image_mounts}
        self.assertIn("/etc/resolv.conf", image_destinations)
        self.assertIn("/etc/hosts", image_destinations)

    def test_dispatch_preserves_command_arguments_and_json_output(self):
        with mock.patch.dict(
            CONTROLLER.COMMANDS,
            {"probe": lambda *args: {"args": list(args)}},
            clear=True,
        ):
            self.assertEqual(CONTROLLER.dispatch("probe", ["one", "two"]), {"args": ["one", "two"]})
            output = io.StringIO()
            with (
                mock.patch.object(sys, "argv", ["lakebox-service", "probe", "three"]),
                mock.patch.object(sys, "stdout", output),
            ):
                CONTROLLER.main()
            self.assertEqual(json.loads(output.getvalue()), {"args": ["three"]})
            with (
                mock.patch.object(sys, "stderr", io.StringIO()),
                self.assertRaisesRegex(SystemExit, "2"),
            ):
                CONTROLLER.dispatch("missing", [])


if __name__ == "__main__":
    unittest.main()
