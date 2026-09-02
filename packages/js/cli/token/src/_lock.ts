/** Service-process singleton coordination. */
import { fileLock } from "@dbx-tools/core";
import { error } from "@dbx-tools/shared-core";

/** Hold the service singleton lock until its server callback exits. */
export async function withBrokerServiceLock<T>(
  service: string,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fileLock.withFileLock(["token-broker", "service", service], run, {
      timeoutMs: 0,
    });
  } catch (cause) {
    if (error.errorMessage(cause).startsWith("Timed out waiting for file lock:")) {
      throw new Error(`Token broker service ${service} is already running`);
    }
    throw cause;
  }
}
