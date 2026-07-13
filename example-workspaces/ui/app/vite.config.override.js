/**
 * Example unmanaged Vite override for the `ui/app` example package.
 *
 * The projen-owned, read-only `vite.config.ts` beside this file scans for
 * `vite.config.override.js` at Vite startup and, when present, merges this module's
 * default export OVER the generated config via Vite's `mergeConfig` (later wins;
 * arrays such as `plugins` concatenate rather than replace). This is how a package
 * customizes Vite WITHOUT editing the generated file - edit or delete this file
 * freely, it is NOT managed by projen.
 *
 * The default export may be a `UserConfig` object (as below) or a
 * `(env) => UserConfig | Promise<UserConfig>` function when the tweak needs Vite's
 * `command`/`mode` (e.g. a dev-only setting).
 */
import { fileURLToPath } from "node:url";

/** @type {import("vite").UserConfig} */
export default {
  // Pin the dev server to a fixed port instead of Vite's default 5173.
  server: {
    port: 5180,
    strictPort: true,
  },
  // Let source import `@/x` as a shortcut for this package's `src/x`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
};
