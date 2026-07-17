import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitepress";

const root = process.cwd();
const generated = path.join(root, ".docs-build", "site");
const navPath = path.join(generated, ".vitepress", "nav.json");
const generatedNav = fs.existsSync(navPath)
  ? JSON.parse(fs.readFileSync(navPath, "utf8"))
  : { nav: [], sidebar: [] };

export default defineConfig({
  title: "dbx-tools",
  description:
    "Companion packages for Databricks developers building AppKit, Mastra, Genie, Model Serving, email, and UI integrations.",
  base: process.env.GITHUB_REPOSITORY?.endsWith("/dbx-tools") ? "/dbx-tools/" : "/",
  outDir: path.join(root, ".docs-build", "dist"),
  cleanUrls: true,
  metaChunk: true,
  themeConfig: {
    nav: generatedNav.nav,
    sidebar: generatedNav.sidebar,
    socialLinks: [{ icon: "github", link: "https://github.com/reggie-db/dbx-tools" }],
    search: {
      provider: "local",
    },
  },
});
