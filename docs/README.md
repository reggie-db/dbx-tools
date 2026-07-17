# dbx-tools docs site

The docs site is generated from existing README files and rendered with Astro
Starlight. Do not hand-maintain a second copy of package documentation.

Source of truth:

- `README.md` becomes the docs homepage.
- `workspaces/**/README.md` becomes the package reference.
- `docs/scripts/sync-readmes.mjs` rewrites local README links for the site,
  generates Starlight content, and publishes `llms.txt` / `llms-full.txt`.
- `docs/scripts/generate-api-docs.mjs` generates TypeScript API reference pages
  from package exports using TypeDoc and writes them into the generated
  Starlight content tree.
- The generated Starlight app under `.docs-build/site/` configures navigation,
  static search, edit links, and the GitHub Pages build output.

Start locally while editing content:

```sh
pnpm exec tsx docs/scripts/sync-readmes.mjs
pnpm --dir .docs-build/site install --lockfile=false
node docs/scripts/generate-api-docs.mjs
pnpm --dir .docs-build/site dev
```

Build and preview locally with search:

```sh
pnpm exec tsx docs/scripts/sync-readmes.mjs
pnpm --dir .docs-build/site install --lockfile=false
node docs/scripts/generate-api-docs.mjs
pnpm --dir .docs-build/site build
pnpm --dir .docs-build/site exec astro preview --host 127.0.0.1
```

Build locally:

```sh
pnpm exec tsx docs/scripts/sync-readmes.mjs
pnpm --dir .docs-build/site install --lockfile=false
node docs/scripts/generate-api-docs.mjs
pnpm --dir .docs-build/site build
```

Generated files live under `.docs-build/` and should not be committed.
