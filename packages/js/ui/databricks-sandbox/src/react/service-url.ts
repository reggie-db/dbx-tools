/** Resolves an AppKit service path against the browser origin. */
export function resolveServiceUrl(path: string, origin = window.location.origin): string {
  return new URL(path, origin).toString();
}
