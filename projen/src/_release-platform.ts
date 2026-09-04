/** Cartesian-product release target filter shared by the bump task. */
export function releasePlatformFilter(
  operatingSystems: readonly string[],
  architectures: readonly string[],
): string {
  if ((operatingSystems.length === 0) !== (architectures.length === 0)) {
    throw new Error("--os and --arch must be used together");
  }
  return operatingSystems
    .flatMap((operatingSystem) =>
      architectures.map((architecture) => `${operatingSystem}:${architecture}`),
    )
    .join(",");
}
