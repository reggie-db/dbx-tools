import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as exec from "@dbx-tools/core/exec";
import { object } from "@dbx-tools/shared-core";

export function externalRuntimePackages(dependencies: Readonly<Record<string, string>>): string[] {
  return Object.keys(dependencies).filter((name) => !name.startsWith("@dbx-tools/"));
}

export async function installServiceRuntime(
  bunExecutable: string,
  directory: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "package.json");
  const current = await readOptionalRecord(manifestPath);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...current,
        name: "@dbx-tools/service-runtime",
        private: true,
        dependencies: {
          ...stringRecord(current.dependencies),
          ...dependencies,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await exec.spawn(bunExecutable, ["install", "--production", "--cwd", directory], {
    check: true,
    cwd: directory,
    stdin: "ignore",
    stdout: "capture",
    stderr: "capture",
  });
}

/** Create a clean uv environment and install the primary and companion Python packages. */
export async function installServicePythonPackage(
  uvExecutable: string,
  directory: string,
  packageSpecifiers: readonly string[],
  python: string,
  platform: NodeJS.Platform,
): Promise<string> {
  await rm(directory, { recursive: true, force: true });
  await exec.spawn(
    uvExecutable,
    ["venv", "--managed-python", "--no-project", "--python", python, directory],
    {
      check: true,
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
    },
  );
  const executable = join(directory, platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await exec.spawn(
    uvExecutable,
    ["pip", "install", "--python", executable, "--upgrade", ...packageSpecifiers],
    {
      check: true,
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
    },
  );
  return executable;
}

async function readOptionalRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object.isRecord(value)) throw new Error(`JSON file is not an object: ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!object.isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
