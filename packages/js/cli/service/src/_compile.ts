import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as exec from "@dbx-tools/core/exec";

/** Compile an entrypoint while containing Bun's intermediate executables. */
export async function compileWithBun(
  bunExecutable: string,
  entrypoint: string,
  output: string,
  workingDirectory: string,
  external: readonly string[] = [],
  temporaryDirectory: string = tmpdir(),
): Promise<void> {
  const absoluteEntrypoint = resolve(workingDirectory, entrypoint);
  const absoluteOutput = resolve(workingDirectory, output);
  const before = await bunBuildArtifacts(workingDirectory);
  const compileDirectory = await mkdtemp(join(temporaryDirectory, "dbx-tools-bun-compile-"));
  try {
    await exec.spawn(
      bunExecutable,
      [
        "build",
        absoluteEntrypoint,
        "--compile",
        "--compile-autoload-package-json",
        "--outfile",
        absoluteOutput,
        ...external.flatMap((dependency) => ["--external", dependency]),
      ],
      {
        check: true,
        cwd: compileDirectory,
        stdin: "ignore",
        stdout: "capture",
        stderr: "capture",
      },
    );
  } finally {
    try {
      for (const artifact of await bunBuildArtifacts(workingDirectory)) {
        if (!before.has(artifact)) {
          await rm(join(workingDirectory, artifact), {
            recursive: true,
            force: true,
          });
        }
      }
    } finally {
      await rm(compileDirectory, { recursive: true, force: true });
    }
  }
}

async function bunBuildArtifacts(directory: string): Promise<Set<string>> {
  return new Set(
    (await readdir(directory))
      .filter((name) => name.startsWith(".") && name.endsWith(".bun-build"))
      .sort(),
  );
}
