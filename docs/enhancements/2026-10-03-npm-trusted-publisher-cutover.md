# npm trusted-publisher cutover

Date: 2026-10-03

Status: Waiting for interactive npm approval on a machine that can reach
`registry.npmjs.org`.

## Purpose

Release `v0.9.19` completed Cargo, PyPI, documentation, and GitHub asset
publication. npm published 55 packages and staged nine packages that require an
interactive maintainer approval. This one-time cutover approves those stages and
authorizes the repository's production workflow as the direct npm publisher for
all 63 packages.

Future npm releases use GitHub Actions OIDC only. The production workflow does
not accept `NPM_TOKEN`, create packages, or fall back to staged publishing.

## Approved release identity

- Tag: `v0.9.19`
- Version: `0.9.19`
- Commit: `a426a0dbf8aa0acfed0ba8566101dc1cdad38d1b`
- Repository: `reggie-db/dbx-tools`
- Workflow: `.github/workflows/release.yml`
- npm packages in `release-manifest.json`: 63
- npm stages requiring approval: 9

## Requirements

Run the helper on a trusted machine with:

- network access to `https://registry.npmjs.org`;
- Bash;
- Bun;
- `gh`, authenticated to read `reggie-db/dbx-tools` releases;
- `jq`;
- an npm maintainer account with package write access and 2FA enabled.

The helper pins npm CLI `11.19.0` through `bunx`, downloads the approved release
manifest, and refuses a different tag, version, commit, package count, or staged
package set.

## Run

From a clone of this repository:

```bash
bash docs/enhancements/2026-10-03-npm-trusted-publisher-cutover.sh
```

npm opens browser authentication and may request 2FA during stage approval and
trusted-publisher administration. npm offers a short 2FA grace period for bulk
trust configuration; accept it if shown. The helper waits two seconds between
trust changes to reduce registry throttling.

The script:

1. downloads `release-manifest.json` from `v0.9.19`;
2. verifies the tag, version, commit SHA, and 63-package npm inventory;
3. lists staged packages and resolves the nine expected package versions to
   their stage UUIDs;
4. approves each stage UUID;
5. configures or verifies `reggie-db/dbx-tools` and `release.yml` with direct
   publish permission for every package;
6. verifies that none of the nine `0.9.19` stages remain.

The helper stops rather than replacing a conflicting trusted publisher. If it
fails, keep the complete terminal output and return it here. It is safe to rerun
after correcting the reported package.

## Completion

Successful output ends with:

```text
Approved 9 staged packages and verified 63 trusted publishers.
```

After that result, verify the nine packages are public at `0.9.19`, remove the
temporary repository `NPM_TOKEN` secret, and move this runbook to
`docs/archived/enhancements` with its final result recorded.
