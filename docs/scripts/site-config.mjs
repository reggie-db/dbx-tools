/** Resolve the canonical docs URL and route base for local and Pages builds. */
export function docsSiteConfig(env = process.env) {
  const site = env.DOCS_SITE_URL?.trim() || "https://reggie-db.github.io";
  const configuredBase = env.DOCS_BASE;
  const rawBase =
    configuredBase !== undefined
      ? configuredBase
      : env.GITHUB_REPOSITORY?.endsWith("/dbx-tools")
        ? "/dbx-tools"
        : "";
  const normalized = rawBase.trim().replace(/^\/+|\/+$/g, "");
  return {
    site: site.replace(/\/+$/g, ""),
    base: normalized ? `/${normalized}` : "",
  };
}
