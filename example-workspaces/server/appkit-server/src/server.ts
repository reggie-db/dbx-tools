import { createApp, server } from "@databricks/appkit";

/**
 * Minimal AppKit server example: health route only.
 * Run with `pnpm exec projen dev` from this package directory.
 */
await createApp({
  plugins: [server()],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.get("/api/health", (_req, res) => {
        res.json({ ok: true, service: "appkit-server" });
      });
    });
  },
});
