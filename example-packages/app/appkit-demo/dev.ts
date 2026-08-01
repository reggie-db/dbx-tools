import { existsSync } from "node:fs";
import index from "./index.html";

// Unmanaged override (bun-dev.override.ts): its default export is merged over the
// generated serve options - later wins - so a package tweaks the dev server
// without editing this generated file.
let options: Bun.ServeFunctionOptions<unknown, {}> = {
  port: Number(process.env.PORT ?? 5173),
  development: { hmr: true, console: true },
  routes: { "/*": index },
};

const overrideUrl = new URL("./bun-dev.override.ts", import.meta.url);
if (existsSync(overrideUrl)) {
  const mod = await import(overrideUrl.href);
  const override = typeof mod.default === "function" ? await mod.default() : mod.default;
  options = { ...options, ...override };
}

const server = Bun.serve(options);
console.log("dev server running at " + server.url.href);
