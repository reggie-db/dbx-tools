#!/usr/bin/env -S bun
/** Validate one stable release version against the canonical workspace policy. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as projectUtils from "@dbx-tools/core/project-utils";
import { captureTaskCommand } from "../../src/_task-command.ts";
import { compareSemver, parseSemver, type Semver } from "../../src/workspace-version.ts";

function publishedVersion(root: string, prefixes: readonly string[]): string | undefined {
  let best: Semver | undefined;
  for (const prefix of prefixes) {
    const tags = captureTaskCommand(root, "git", [
      "-c",
      "versionsort.suffix=-",
      "tag",
      "--sort=-version:refname",
      "--list",
      `${prefix}*`,
    ]);
    for (const tag of tags.split("\n")) {
      if (!tag.startsWith(prefix)) continue;
      const version = parseSemver(tag.slice(prefix.length));
      if (version && (!best || compareSemver(version, best) > 0)) best = version;
    }
  }
  return best?.join(".");
}

export function assertReleaseVersion(
  version: string,
  options: { root?: string; prefixes?: readonly string[]; assertNext?: boolean } = {},
): void {
  const parsed = parseSemver(version);
  if (!parsed) {
    throw new Error(
      `release version must be an exact stable x.y.z, got ${JSON.stringify(version)}`,
    );
  }
  if (!options.assertNext) return;
  const root = resolve(options.root ?? projectUtils.root() ?? process.cwd());
  const prefixes = options.prefixes?.length ? options.prefixes : ["v"];
  const current = publishedVersion(root, prefixes);
  const currentParsed = current ? parseSemver(current) : undefined;
  if (currentParsed && compareSemver(parsed, currentParsed) <= 0) {
    throw new Error(`release version ${version} must be greater than published ${current}`);
  }
}

export function main(args: string[] = process.argv.slice(2)): void {
  const { values } = parseArgs({
    args,
    options: {
      version: { type: "string" },
      root: { type: "string" },
      prefix: { type: "string", multiple: true },
      "assert-next": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.version) throw new Error("--version is required");
  assertReleaseVersion(values.version, {
    ...(values.root ? { root: values.root } : {}),
    ...(values.prefix ? { prefixes: values.prefix } : {}),
    assertNext: values["assert-next"],
  });
}
