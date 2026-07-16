import { createApp } from "@databricks/appkit";

/**
 * Minimal AppKit server example: health route only.
 * Run with `pnpm exec projen dev` from this package directory.
 */
const app = createApp({ title: "dbx-tools AppKit server example" });

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "appkit-server" });
});

app.listen();
