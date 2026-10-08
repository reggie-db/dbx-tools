/**
 * Install the pinned multi-file Genie Code runtime under dbx-tools ownership.
 *
 * @module
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bin } from "@dbx-tools/core";
import { GENIE_CODE_VERSION } from "@dbx-tools/shared-genie-code/options";

interface GenieCodeAsset {
  target: string;
  sha256: string;
}

const GENIE_CODE_ASSETS = {
  "darwin:arm64": {
    target: "aarch64-apple-darwin",
    sha256: "78cc7e358c8bfc62d6da26364c762be37fc2e2a10b7e83f21a3b166f901f528e",
  },
  "darwin:x64": {
    target: "x86_64-apple-darwin",
    sha256: "2021b8b27ec3116fc015c1676b5f65c3ce11d57f1dff9c302aae135f6e4f1a5f",
  },
  "linux:arm64": {
    target: "aarch64-unknown-linux-musl",
    sha256: "dfd278c267dde43e1fe7e7d7a0da8d7a1a148cdf3d2004bd30b351645c4fe0a7",
  },
  "linux:x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "e3d9a55f6d51bdc745eda4744fb827ba1df6dacf1069518f7347a59f48c89430",
  },
  "win32:arm64": {
    target: "aarch64-pc-windows-msvc",
    sha256: "aeac95bd0148f942194270ba932245cec32e98da67292ba7b008bcab675ba7f8",
  },
  "win32:x64": {
    target: "x86_64-pc-windows-msvc",
    sha256: "c9f92c8d60273250262527bca525451501c4e8351e59927a1686c305be29a922",
  },
} as const satisfies Record<string, GenieCodeAsset>;

/** Host overrides used by installation tests and embedded callers. */
export interface InstallGenieCodeOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
}

/** Resolve the pinned release asset for one supported host. */
export function genieCodeAsset(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): GenieCodeAsset {
  const asset = GENIE_CODE_ASSETS[`${platform}:${architecture}` as keyof typeof GENIE_CODE_ASSETS];
  if (!asset) {
    throw new Error(
      `Genie Code ${GENIE_CODE_VERSION} does not support ${platform}/${architecture}`,
    );
  }
  return asset;
}

/** Install and return the shared Genie Code package entrypoint. */
export async function installGenieCode(
  options: InstallGenieCodeOptions = {},
): Promise<bin.BinContext> {
  const platform = options.platform ?? process.platform;
  const asset = genieCodeAsset(platform, options.architecture ?? process.arch);
  const executable = platform === "win32" ? "genie.exe" : "genie";
  const helper = platform === "win32" ? "genie-code-mode-host.exe" : "genie-code-mode-host";
  const entrypoint = join("bin", executable);
  const root = join(
    options.homeDirectory ?? homedir(),
    ".dbx-tools",
    "genie",
    "releases",
    `${GENIE_CODE_VERSION}-${asset.target}`,
  );
  const destination: bin.BinContext = {
    root,
    binDir: join(root, dirname(entrypoint)),
    path: join(root, entrypoint),
  };
  const url =
    `https://github.com/databricks/genie-code-cli/releases/download/v${GENIE_CODE_VERSION}/` +
    `genie-package-${asset.target}.tar.gz`;
  return bin.ensure(
    "genie",
    { url, sha256: asset.sha256 },
    {
      destination,
      minVersion: "0.1.0",
      versionParser: ({ stdout }) =>
        stdout.trim() === `genie ${GENIE_CODE_VERSION}` ? "0.1.0" : undefined,
      package: {
        entrypoint,
        requiredPaths: ["genie-package.json", join("bin", helper), "genie-path", "genie-resources"],
      },
    },
  );
}
