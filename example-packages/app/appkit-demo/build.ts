import { existsSync } from "node:fs";
import { basename } from "node:path";
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

// Fix a Bun bug: with \`splitting: true\` and an HTML entrypoint, the emitted
// HTML's <script src> is wired to an arbitrary chunk instead of the JS
// entry-point, so the app never boots (a blank page). Rewrite the HTML script
// (and stylesheet) to the real entry-point outputs. No-op when they already
// match (e.g. splitting off), so it is always safe to run.
const htmlOut = result.outputs.find((o) => o.path.endsWith(".html"));
const entryJs = result.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".js"));
const entryCss = result.outputs.find((o) => o.kind === "entry-point" && o.path.endsWith(".css"));
if (htmlOut && entryJs) {
  let html = await Bun.file(htmlOut.path).text();
  const jsName = basename(entryJs.path);
  html = html.replace(/(<script[^>]*\bsrc=")([^"]*\/)?[^"/]+\.js(")/i, "$1$2" + jsName + "$3");
  if (entryCss) {
    const cssName = basename(entryCss.path);
    html = html.replace(/(<link[^>]*\bhref=")([^"]*\/)?[^"/]+\.css(")/i, "$1$2" + cssName + "$3");
  }
  await Bun.write(htmlOut.path, html);
}

console.log("built " + result.outputs.length + " files to " + options.outdir);
