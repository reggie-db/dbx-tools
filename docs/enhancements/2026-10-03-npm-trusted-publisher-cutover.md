# npm trusted-publisher cutover

Date: 2026-10-03

Status: The nine `0.9.19` package versions are public. Waiting for interactive
trusted-publisher verification on a machine that can reach `registry.npmjs.org`.

## Purpose

Release `v0.9.19` completed Cargo, PyPI, documentation, GitHub asset, and npm
publication. The final nine npm stages have since been approved. This one-time
cutover verifies those package versions and authorizes the repository's
production workflow as the direct npm publisher for all 63 packages.

Future npm releases use GitHub Actions OIDC only. The production workflow does
not accept `NPM_TOKEN`, create packages, or fall back to staged publishing.

## Approved release identity

- Tag: `v0.9.19`
- Version: `0.9.19`
- Commit: `a426a0dbf8aa0acfed0ba8566101dc1cdad38d1b`
- Repository: `reggie-db/dbx-tools`
- Workflow: `.github/workflows/release.yml`
- npm packages in `release-manifest.json`: 63
- npm package versions verified public after staged approval: 9

## GitHub token probe

A temporary GitHub Actions probe ran on October 3, 2026, then was removed. It
confirmed:

- repository secret `NPM_TOKEN` authenticates as `reggie-db`;
- `reggie-db` has read-write access to all nine cutover packages;
- every cutover package is public at `0.9.19`;
- no `@dbx-tools` stages remain visible to that account.

The token cannot configure or inspect trusted publishers in GitHub Actions.
npm treats trusted-publisher administration as an account-governance action and
requires an interactive 2FA challenge. Keep the token only until the interactive
cutover below verifies all 63 trust records.

## Requirements

Run the helper on a trusted machine with:

- network access to `https://registry.npmjs.org`;
- Bash;
- Bun;
- `gh`, authenticated to read `reggie-db/dbx-tools` releases;
- `jq`;
- an npm maintainer account with package write access and 2FA enabled.

The helper pins npm CLI `11.19.0` through `bunx`, downloads the approved release
manifest, and refuses a different tag, version, commit, or package count. It is
safe to rerun after some or all stages have already been approved.

## Run

From a clone of this repository:

```bash
bash docs/enhancements/2026-10-03-npm-trusted-publisher-cutover.sh
```

npm opens browser authentication and requests 2FA for trusted-publisher
administration. npm offers a short 2FA grace period for bulk trust configuration;
accept it if shown. The helper waits two seconds between trust changes to reduce
registry throttling.

The script:

1. downloads `release-manifest.json` from `v0.9.19`;
2. verifies the tag, version, commit SHA, and 63-package npm inventory;
3. verifies the nine cutover versions, approving a stage only if one still
   exists;
4. configures or verifies `reggie-db/dbx-tools` and `release.yml` with direct
   publish permission for every package;
5. verifies that none of the nine `0.9.19` stages remain and that every cutover
   version is public.

The helper stops rather than replacing a conflicting trusted publisher. If it
fails, keep the complete terminal output and return it here. It is safe to rerun
after correcting the reported package.

## Completion

Successful output ends with:

```text
Approved 0 pending stages, verified 9 cutover versions, and verified 63 trusted publishers.
```

After that result, remove the temporary repository `NPM_TOKEN` secret and move
this runbook to `docs/archived/enhancements` with its final result recorded.
