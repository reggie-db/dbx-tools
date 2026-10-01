export const FINGERPRINT_SCHEMA: number;
export const VERSION_SLOT_SCHEMA: number;
export const VERSION_CAPACITY: number;

export function repositoryRoot(cwd?: string): string;
export function normalizeManifest(text: string): string;
export function normalizeLockfile(text: string, workspaceVersion: string): string;
export function sourceHash(root: string, sources?: readonly string[]): string;
export function linkerIdentity(target: string): string;
export function targetKey(options: {
  rustSourceHash: string;
  target: string;
  targetConfig?: string;
  toolchain?: string;
  rustc?: string;
}): string;
export function fingerprint(options: {
  root?: string;
  output?: string;
  check?: boolean;
  targets: readonly string[];
  toolchain?: string;
  portable?: boolean;
  sources?: readonly string[];
}): {
  schemaVersion: number;
  versionSlotSchema: number;
  rustSourceHash: string;
  targets: Record<string, string>;
};
export function stamp(binary: string, version: string): boolean;
export function stampTree(root: string, version: string): number;
export function main(args?: readonly string[]): unknown;
