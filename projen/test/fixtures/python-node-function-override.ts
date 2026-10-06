export async function acquireFileLock(): Promise<{
  backend: "file";
  release(): Promise<void>;
}> {
  return {
    backend: "file",
    async release(): Promise<void> {},
  };
}
