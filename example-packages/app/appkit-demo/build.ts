import { existsSync } from "node:fs";
import tailwind from "bun-plugin-tailwind";

// Unmanaged override (bun-build.override.ts): its default export is merged over
// the generated build options - later wins.
let options: Bun.BuildConfig = {
  entrypoints: ["./index.html"],
  outdir: "./dist",
  minify: true,
  sourcemap: "linked",
  plugins: [tailwind],
};

const overrideUrl = new URL("./bun-build.override.ts", import.meta.url);
if (existsSync(overrideUrl)) {
  const mod = await import(overrideUrl.href);
  const override = typeof mod.default === "function" ? await mod.default() : mod.default;
  options = { ...options, ...override, plugins: [...(options.plugins ?? []), ...(override.plugins ?? [])] };
}

const result = await Bun.build(options);
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
console.log("built " + result.outputs.length + " files to " + options.outdir);
