# dbx-tools docs

This directory holds the docs-site generator. Any `docs/*.md` added beside it
becomes a hand-written guide on the site; there are none today.

## Docs site

The docs site is generated from existing README files and rendered with Astro
Starlight. Do not hand-maintain a second copy of package documentation.

Source of truth:

- `README.md` becomes the docs homepage.
- `packages/js/**/README.md` and `packages/py/**/README.md` become the package
  reference, alongside publishable Rust crate READMEs.
- `docs/*.md` guides become the site's Guides section.
- `docs/scripts/sync-readmes.mjs` rewrites local README links for the site,
  generates Starlight content, and publishes `llms.txt` / `llms-full.txt`.
- `docs/scripts/generate-api-docs.mjs` resolves TypeScript entries from npm
  export maps, generates Python references from source ASTs and docstrings, and
  runs Cargo rustdoc for publishable Rust crates.
- `docs/scripts/repository-docs.mjs` owns the package catalogue, route slugging,
  and README summary rules shared by both generators.
- `docs/toolchain.json` pins the exact Astro, Starlight, TypeDoc, and TypeDoc
  Markdown versions written into the generated site package.
- `docs/scripts/check-source-docs.mjs` rejects new undocumented handwritten
  TypeScript declarations exposed by package export maps. Its committed baseline
  ratchets downward as existing declarations are documented.
- The generated Starlight app under `.docs-build/site/` configures navigation,
  static search, edit links, and the GitHub Pages build output.

The API build requires Python 3.11 or newer and a Rust toolchain in addition to
Bun. Start locally while editing content:

```sh
bun docs/scripts/sync-readmes.mjs
bun install --cwd .docs-build/site
bun docs/scripts/check-source-docs.mjs
bun docs/scripts/generate-api-docs.mjs
bun run --cwd .docs-build/site dev
```

Build and preview locally with search:

```sh
bun docs/scripts/sync-readmes.mjs
bun install --cwd .docs-build/site
bun docs/scripts/check-source-docs.mjs
bun docs/scripts/generate-api-docs.mjs
bun run --cwd .docs-build/site build
bun run --cwd .docs-build/site check-links
cd .docs-build/site && bun x astro preview --host 127.0.0.1
```

Build locally:

```sh
bun docs/scripts/sync-readmes.mjs
bun install --cwd .docs-build/site
bun docs/scripts/check-source-docs.mjs
bun docs/scripts/generate-api-docs.mjs
bun run --cwd .docs-build/site build
bun run --cwd .docs-build/site check-links
```

`check-links` validates built internal routes, assets, and fragments directly
from `.docs-build/dist`. It starts no HTTP server and makes no external network
requests, so release validation is deterministic.

Generated files live under `.docs-build/` and should not be committed.
Update `docs/toolchain.json` in a reviewed change when upgrading documentation
dependencies; the generator rejects ranges, missing tools, and unknown entries.
When existing public TypeScript declarations gain JSDoc, refresh the ratchet with
`bun docs/scripts/check-source-docs.mjs --write-baseline` and review the baseline
diff before committing it.
The published site uses `https://docs.dbx.tools` with a root base path. GitHub Pages
custom-domain state is configured through repository settings or the Pages API;
Actions-based Pages ignores a repository or artifact `CNAME` file.

After the Pages custom domain is set to `docs.dbx.tools`, configure the CNAME
with a Cloudflare token carrying Zone Read and DNS Edit:

```sh
CLOUDFLARE_API_TOKEN=... scripts/configure-pages-dns.sh
```

The script replaces existing records for `docs.dbx.tools` with a CNAME to
`reggie-db.github.io` and leaves Cloudflare proxying disabled for GitHub's DNS
and TLS verification.
