import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CliService } from "../src/service.ts";

describe("CLI service lifecycle", () => {
  it("installs and uninstalls package-owned state without starting", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-cli-service-"));
    const dataDirectory = join(root, "data");
    const globalHomeDirectory = join(root, ".dbx-tools");
    const hostEntrypoint = join(root, "service-host.ts");
    const commandEntrypoint = join(root, "gateway.ts");
    const trayExecutable = join(root, "tray_linux_release");
    await writeFile(hostEntrypoint, "");
    await writeFile(commandEntrypoint, "");
    await writeFile(trayExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(trayExecutable, 0o755);
    const compiled: string[] = [];
    const pythonInstalls: unknown[] = [];
    const service = new CliService(
      {
        id: "com.example.gateway",
        name: "Example Gateway",
        packageName: "@dbx-tools/cli-service",
        version: "1.2.3",
        icon: join(root, "icon.png"),
        dataDirectory,
        pythonPackage: {
          name: "example-runtime",
          python: "3.12",
          dependencies: ["companion-runtime==4.5.6"],
        },
        command: {
          entrypoint: commandEntrypoint,
          arguments: ["--port", "4401"],
        },
      },
      {
        platform: "linux",
        homeDirectory: root,
        temporaryDirectory: root,
        environment: { XDG_CONFIG_HOME: join(root, "config") },
        globalHomeDirectory,
        bunExecutable: "/opt/bun",
        uvExecutable: "/opt/uv",
        hostEntrypoint,
        trayExecutable,
        async compile(entrypoint, output) {
          compiled.push(entrypoint);
          await writeFile(output, "#!/bin/sh\nexit 0\n");
          await chmod(output, 0o755);
        },
        async installRuntime() {},
        async installPython(uv, directory, packageSpecifiers, python, platform) {
          pythonInstalls.push({ uv, directory, packageSpecifiers, python, platform });
          return join(directory, "bin/python");
        },
      },
    );

    await service.install({ start: false });

    assert.deepEqual(await service.status(), { installed: true, running: false });
    const configuration = JSON.parse(
      await readFile(join(dataDirectory, "service.json"), "utf8"),
    ) as {
      id: string;
      pythonPackage: { name: string; version: string; python: string; dependencies: string[] };
      command: { executable: string; entrypoint?: string; environment: Record<string, string> };
    };
    assert.equal(configuration.id, "com.example.gateway");
    assert.deepEqual(configuration.pythonPackage, {
      name: "example-runtime",
      version: "1.2.3",
      python: "3.12",
      dependencies: ["companion-runtime==4.5.6"],
    });
    assert.equal(configuration.command.entrypoint, undefined);
    assert.equal(
      configuration.command.executable,
      join(globalHomeDirectory, "bin", "example-gateway-command"),
    );
    assert.equal(
      configuration.command.environment.PYTHON,
      join(dataDirectory, "python/bin/python"),
    );
    assert.deepEqual(pythonInstalls, [
      {
        uv: "/opt/uv",
        directory: join(dataDirectory, "python"),
        packageSpecifiers: ["example-runtime==1.2.3", "companion-runtime==4.5.6"],
        python: "3.12",
        platform: "linux",
      },
    ]);
    assert.deepEqual(compiled, [commandEntrypoint, hostEntrypoint]);
    const startup = await readFile(
      join(root, "config", "autostart", "com.example.gateway.desktop"),
      "utf8",
    );
    assert.match(startup, /example-gateway/);
    await stat(join(globalHomeDirectory, "bin", "traybin", "tray_linux_release"));

    await service.uninstall();

    await assert.rejects(() => stat(dataDirectory), { code: "ENOENT" });
    await stat(join(globalHomeDirectory, "bin", "example-gateway"));
    await assert.rejects(
      () => stat(join(root, "config", "autostart", "com.example.gateway.desktop")),
      { code: "ENOENT" },
    );
  });
});
