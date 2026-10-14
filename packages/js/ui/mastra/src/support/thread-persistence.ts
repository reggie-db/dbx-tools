/** Build the browser storage key for one Mastra agent's selected thread. */
export function threadStorageKey(
  basePath: string,
  agentId: string,
  resourceScope?: string,
): string {
  const prefix = `dbx-mastra-thread:${basePath}:${agentId}`;
  return resourceScope ? `${prefix}:${encodeURIComponent(resourceScope)}` : prefix;
}
