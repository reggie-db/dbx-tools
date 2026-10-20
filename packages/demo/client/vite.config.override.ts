import { isLevelEnabled } from "@dbx-tools/shared-core";
import { tunnelAllowedHosts } from "@dbx-tools/tunnel";
import { createLogger, defineConfig } from "vite";

/**
 * Extend the generated AppKit Vite configuration with demo tunnel behavior.
 */
const tunnelHosts = tunnelAllowedHosts();

export default defineConfig({
  ...(isLevelEnabled("debug") ? {} : { logLevel: "silent", customLogger: createLogger("silent") }),
  ...(tunnelHosts.length > 0 ? { server: { allowedHosts: tunnelHosts } } : {}),
});
