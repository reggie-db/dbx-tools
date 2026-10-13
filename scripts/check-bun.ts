/** Minimum Bun version accepted by this workspace. */
const MINIMUM_VERSION = "1.4.2";

/** Convert one Bun version into a three-part numeric tuple. */
function versionTuple(version: string): [number, number, number] {
  const parts = version.split("-", 1)[0]!.split(".");
  return [0, 1, 2].map((index) => Number.parseInt(parts[index] ?? "0", 10)) as [
    number,
    number,
    number,
  ];
}

const current = versionTuple(Bun.version);
const minimum = versionTuple(MINIMUM_VERSION);
const isTooOld = current.some(
  (part, index) =>
    part < minimum[index]! &&
    current.slice(0, index).every((value, prefix) => value === minimum[prefix]),
);

if (isTooOld) {
  throw new Error(
    `Bun ${MINIMUM_VERSION} or newer is required; running ${Bun.version}. Use "bun run bun" to select the workspace-local Bun binary.`,
  );
}