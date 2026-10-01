#!/usr/bin/env -S bun
/** Validate one stable release version against the canonical workspace policy. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { project } from "@dbx-tools/core";
import { compareSemver, parseSemver, resolveRemoteVersion } from "../src/workspace-version.ts";

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
  const root = resolve(options.root ?? project.root() ?? process.cwd());
  const prefixes = options.prefixes?.length ? options.prefixes : ["v"];
  const current = resolveRemoteVersion(root, prefixes, { fetch: false });
  const currentParsed = current ? parseSemver(current) : undefined;
  if (currentParsed && compareSemver(parsed, currentParsed) <= 0) {
    throw new Error(`release version ${version} must be greater than published ${current}`);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
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
