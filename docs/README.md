# dbx-tools docs site

The docs site is generated from existing README files. Do not hand-maintain a
second copy of package documentation.

Source of truth:

- `README.md` becomes the docs homepage.
- `workspaces/**/README.md` becomes the package reference.
- `docs/scripts/sync-readmes.mjs` rewrites local README links for the site and
  generates `llms.txt` / `llms-full.txt`.

Build locally:

```sh
node docs/scripts/sync-readmes.mjs
pnpm dlx vitepress@1.6.4 build .docs-build/site --config docs/vitepress.config.mts
```

Generated files live under `.docs-build/` and should not be committed.
