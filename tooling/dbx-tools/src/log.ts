import { createConsola } from "consola";

/**
 * The single dev logger, built from consola. Everything is routed to **stderr**
 * (both streams point there) so stdout stays clean for piping and tool output.
 *
 * Tag per task at the call site, e.g. `logger.withTag("projen:watch")`.
 */
export const logger = createConsola({
  stdout: process.stderr,
  stderr: process.stderr,
});
