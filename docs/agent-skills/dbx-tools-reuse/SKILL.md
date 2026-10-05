---
name: dbx-tools-reuse
description: Choose and reuse current @dbx-tools packages and @dbx-tools/projen before adding project generators, helpers, dependencies, or Databricks integration code. Use for work in github-reggie-db and for new Bun-first TypeScript or polyglot repositories.
metadata:
  version: "0.9.22"
---

# dbx-tools reuse

Use the active `dbx-tools` repository as the source of truth. Start with the
[generated package catalog](references/package-catalog.md), then inspect the
selected package's current manifest, README, exports, and source. Do not infer
an API from the catalog summary or training data.

For a new Bun-first TypeScript or TypeScript/Python workspace, prefer
`@dbx-tools/projen`. Read `projen/README.md` and use the repository's
workspace-local `bun run sync` workflow. Do not invoke Projen through `npx`.

For an existing project, reuse the narrowest matching package. Check the
installed version and existing dependencies before introducing another helper
or dependency. If the needed capability is absent, extend the owning package
instead of duplicating it in an application when that ownership is sensible.

Treat `reggie-bricks`, `apx`, and historical `dbx-tools-js-release`
repositories as defunct. Do not recommend or import from them.
