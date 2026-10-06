# dbx-tools docs

This directory holds the docs-site generator. Any `docs/*.md` added beside it
becomes a hand-written guide on the site; there are none today.

## Write Package Guides For Users

Package READMEs are product guides, not implementation notes. Follow the same
progression as AppKit documentation:

1. Open with the outcome the package enables and why a user would choose it.
2. Show the shortest successful path with a runnable example.
3. Organize the rest around user tasks, choices, expected behavior, and limits.
4. Put module lists and generated API references last.

Prefer headings such as `Quick Start`, `Choose A Target`, `Run As A Service`,
and `Handle Errors`. Avoid leading with ownership boundaries, internal classes,
dependency graphs, protocol routing, caches, or build details. Include those
only when they change how a caller uses or operates the package.

Every published package README must have a useful opening summary, at least two
task-oriented H2 sections, and a runnable fenced example. The docs generator
checks this structure before producing the site. Because the first prose
paragraph is also used in package indexes and `llms.txt`, make it a direct value
statement rather than a technical inventory.

Public TypeScript declarations need JSDoc that explains caller-visible purpose,
inputs, outputs, errors, and lifecycle constraints where relevant. Public Python
classes and functions need equivalent docstrings. Generated API pages should
add detail to the README rather than compensate for missing task guidance.

Development policies, dependency-installation safeguards, and implementation
history belong in contributor instructions, not package product guides.

## Generate CLI References

CLI READMEs end with command references derived from their parsers. Commander
provides the exact help text for every visible subcommand, including global
options, defaults, choices, and environment variables. Cyclopts generates the
Python Graphiti reference and the options forwarded by the Bun launcher.
Built-in help commands and flags are excluded.

```sh
python3 -m pip install -r docs/requirements.txt
bun run docs:cli
bun run docs:check-readmes
```

The generator uses the repository's `.venv/bin/python` when available, or
`PYTHON` / `python3`. Edit descriptions and options in the owning parser, then
regenerate. Keep task-oriented guidance outside the `cli-reference` markers;
do not edit generated sections or maintain separate flag tables. Documentation
validation and the release docs workflow reject stale references.

## Docs site

The docs site is generated from existing README files and rendered with Astro
Starlight. Do not hand-maintain a second copy of package documentation.

Source of truth:

- `README.md` becomes the docs homepage.
- `packages/js/**/README.md` and `packages/py/**/README.md` become the package
  reference.
- `docs/*.md` guides become the site's Guides section.
- `docs/scripts/sync-readmes.mjs` rewrites local README links for the site,
  generates Starlight content, and publishes `llms.txt` / `llms-full.txt`.
- `docs/scripts/generate-api-docs.mjs` resolves TypeScript entries from npm
  export maps and generates Python references from source ASTs and docstrings.
- `docs/scripts/repository-docs.mjs` owns the package catalogue, route slugging,
  and README summary rules shared by both generators.
- `docs/toolchain.json` pins the exact Astro, Starlight, TypeDoc, and TypeDoc
  Markdown versions written into the generated site package.
- `docs/scripts/check-source-docs.mjs` rejects undocumented handwritten Python
  declarations and new undocumented TypeScript declarations exposed by package
  export maps. The TypeScript baseline ratchets downward as existing
  declarations are documented.
- The generated Starlight app under `.docs-build/site/` configures navigation,
  static search, edit links, and the GitHub Pages build output.

The API build requires Python 3.11 or newer in addition to Bun. Start locally
while editing content:

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
