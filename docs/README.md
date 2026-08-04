# dbx-tools docs

This directory holds the docs-site generator. Any `docs/*.md` added beside it
becomes a hand-written guide on the site; there are none today.

## Docs site

The docs site is generated from existing README files and rendered with Astro
Starlight. Do not hand-maintain a second copy of package documentation.

Source of truth:

- `README.md` becomes the docs homepage.
- `js-packages/**/README.md` becomes the package reference.
- `docs/*.md` guides become the site's Guides section.
- `docs/scripts/sync-readmes.mjs` rewrites local README links for the site,
  generates Starlight content, and publishes `llms.txt` / `llms-full.txt`.
- `docs/scripts/generate-api-docs.mjs` generates TypeScript API reference pages
  from package exports using TypeDoc and writes them into the generated
  Starlight content tree.
- The generated Starlight app under `.docs-build/site/` configures navigation,
  static search, edit links, and the GitHub Pages build output.

Start locally while editing content:

```sh
bun docs/scripts/sync-readmes.mjs
bun install --cwd .docs-build/site
bun docs/scripts/generate-api-docs.mjs
bun run --cwd .docs-build/site dev
```

Build and preview locally with search:

```sh
bun docs/scripts/sync-readmes.mjs
bun install --cwd .docs-build/site
bun docs/scripts/generate-api-docs.mjs
bun run --cwd .docs-build/site build
cd .docs-build/site && bun x astro preview --host 127.0.0.1
```

Build locally:

```sh
bun docs/scripts/sync-readmes.mjs
bun install --cwd .docs-build/site
bun docs/scripts/generate-api-docs.mjs
bun run --cwd .docs-build/site build
```

Generated files live under `.docs-build/` and should not be committed.
