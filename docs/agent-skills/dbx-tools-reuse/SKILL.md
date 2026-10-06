---
name: dbx-tools-reuse
description: Enforce owning-library-first reuse of current @dbx-tools packages, Projen, and installed frameworks before adding or reviewing generators, wrappers, helpers, dependencies, workflows, or Databricks integration code. Use for work in github-reggie-db and for new Bun-first TypeScript or polyglot repositories.
metadata:
  version: "0.9.44"
---

# dbx-tools reuse

Use the active `dbx-tools` repository as the source of truth. Start with the
[generated package catalog](references/package-catalog.md), then inspect the
selected package's current manifest, README, exports, and source. Do not infer
an API from the catalog summary or training data.

Before implementing or reviewing a capability, identify its owner and inspect
the exact installed version's public API, documentation, type declarations,
exports, and source. Search git history when similar local code existed or was
removed. Existing ownership is a hard stop for local wrappers, subclasses,
facades, copied algorithms, parallel configuration, generated-output patches,
or fallback implementations. Documented configuration and extension points are
library use, not customization.

For a new Bun-first TypeScript or TypeScript/Python workspace, prefer
`@dbx-tools/projen`. Read `projen/README.md` and use the repository's
workspace-local `bun run sync` workflow. Do not invoke Projen through `npx`.
Use Projen project fields and components directly. For example, configure
`project.vscode` instead of adding another VS Code owner. A dbx-tools
component may own only a genuinely unsupported remainder and must keep it
separate from the native component.

For an existing project, reuse the narrowest matching package. Check the
installed version and existing dependencies before introducing another helper
or dependency. If the needed capability is absent, extend the owning package.
If an external owner lacks it, use a different owner or propose an upstream
change instead of recreating owned behavior locally.

Treat ownership overlap as a blocking code-quality finding. Require evidence
that the current owner lacks a capability before accepting a new helper,
wrapper, generator, parser, workflow, or configuration owner. When adopting the
owner, remove the duplicate implementation and update every caller in the same
change.

Treat `reggie-bricks`, `apx`, and historical `dbx-tools-js-release`
repositories as defunct. Do not recommend or import from them.
