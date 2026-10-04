# Singular-version draft-promotion release architecture

Date: 2026-09-30

Updated: 2026-10-04

Status: Implemented. Keep active through the first token-authenticated release
prepared with this transaction, then archive it with the observed release result.

## Goal

Release every public artifact from one version, one Git commit, and one reviewed
candidate. Building the candidate and promoting it are separate operations.

The root `VERSION` file is the only version authority. Projen reproduces that
value in Node manifests, Python projects, the Cargo workspace, generated binding
metadata, native package metadata, runtime registries, release notes, and the
GitHub workflow run name.

## Promotion model

```text
source branch
  -> commit and push pending work
  -> release/v<version>
  -> update VERSION and synthesize
  -> validate and merge the release PR
  -> detach at the exact merge SHA
  -> build the candidate once
  -> optional local registry publication
  -> annotated tag and draft GitHub Release
  -> human publishes the GitHub Release
  -> release.published deploys npm, PyPI, Cargo, and docs
```

Publishing the GitHub Release is the production approval. A branch push, merged
PR, generated release note, or uploaded asset does not publish a registry package.

## Release transaction

`bun run release` operates in one checkout:

1. Acquire the workspace mutation lock.
2. Require a named source branch and a GitHub account with repository management
   permission.
3. Commit pending source work with the configured message.
4. Bring the source branch up to date with `origin/main` and push it.
5. Create or resume `release/v<version>`.
6. Restore a matching `release-resume:<branch>` stash when one exists.
7. Increment the root `VERSION` file.
8. Run Projen synthesis so every generated version surface matches `VERSION`.
9. Run `version:check`, configured release validation tasks, Cargo workspace
   tests, and the workspace compile.
10. Generate and commit the versioned release summary.
11. Push the release branch, open the PR, and optionally enable automatic merge.
12. Wait for required checks and resolve the exact merge commit SHA.
13. Detach the current checkout at that SHA.
14. Build the complete release candidate once.
15. Optionally publish the exact candidate to configured local npm, PyPI, and
    Cargo registries.
16. Create or verify the annotated tag and draft GitHub Release.
17. Upload the already-built candidate.
18. Return to the original source branch.

The transaction does not create a Git worktree. On failure it stashes uncommitted
release-branch state with the `release-resume:<branch>` marker before restoring
the original branch.

## Candidate contents

The draft GitHub Release contains:

- every npm archive;
- every Python wheel and source distribution;
- every native Node archive;
- every native Python wheel;
- every configured Rust binary archive;
- `release-manifest.json`;
- `SHA256SUMS`.

`release-manifest.json` records the repository version, annotated tag, exact Git
commit SHA, artifact kind, package identity where applicable, file size, and
SHA-256. `SHA256SUMS` provides a standard checksum list for operator review.

Candidate construction fails when:

- `HEAD` is not the expected merge SHA;
- `VERSION` does not match the requested release;
- the tracked source is dirty;
- an archive carries another package version;
- two assets resolve to the same release filename;
- a configured native target cannot be built;
- the final manifest cannot be verified.

## Immutable packaging

Source manifests are never repaired during publication.

- Node packages already carry `VERSION`. Publication projects `publishConfig`
  only inside a temporary `.tgz`, then validates and publishes that archive.
- Python projects already carry `VERSION`. Packaging copies each project to a
  temporary directory and projects sibling registry dependencies in the copy.
- Local Cargo publication copies the Cargo workspace to a temporary directory,
  projects registry metadata there, validates every crate version, and publishes
  by `--manifest-path` with `--locked`.
- Native binaries must report the exact requested version. There is no `0.0.0`
  acceptance path and no post-build byte injection.

The candidate uploaded to GitHub is the same candidate used for local registry
preflight. Upload retries use `--upload-existing`; they do not rebuild.

## Production workflow

The generated `.github/workflows/release.yml` listens to:

```yaml
on:
  release:
    types: [published]
```

The verification job:

1. reads the published release tag;
2. requires an annotated tag;
3. resolves the tag to its commit SHA;
4. requires that commit to be on `main`;
5. checks out the exact SHA;
6. verifies the root `VERSION` against the tag;
7. downloads the approved release assets;
8. verifies `release-manifest.json`, `SHA256SUMS`, sizes, hashes, package
   identities, and the expected asset set.

Registry and documentation jobs depend on that verification. GitHub-hosted
runners never rebuild native release artifacts.

### npm

npm publication runs entirely in GitHub Actions with the repository token:

- permissions are `contents: read` and `id-token: write`;
- the workflow publishes the approved `.tgz` files directly;
- `NODE_AUTH_TOKEN` reads the repository `NPM_TOKEN` secret;
- npm `11.4.2` uses the Actions ID token for provenance while retaining token registry authentication;
- no staged-publish fallback or package-creation bootstrap runs during release.

### PyPI

PyPI jobs publish the approved wheel and source archives through package-specific
trusted-publisher environments. Native binding publishers wait for their Python
dependencies. Existing-file recovery compares hashes instead of rebuilding.

### Cargo

Cargo publishes from the verified source commit with `cargo publish --locked`.
Crates publish in dependency order and skip versions that already exist during
manual recovery. Cargo publication does not upload or rebuild binary assets.

### Documentation

The same promotion workflow generates README-derived content and TypeScript API
pages, validates the site, and deploys GitHub Pages. Documentation therefore
shares the approved tag and commit with every package registry.

## Recovery

Manual workflow dispatch accepts an existing published tag and one stage:

- `all`;
- `node`;
- `python`;
- `cargo`;
- `docs`.

Manual runs default to dry-run. Recovery revalidates the same tag, SHA, version,
manifest, and checksums. It never calculates a new version, creates a release,
or rebuilds the candidate.

An interrupted local candidate can be rebuilt from the exact source with:

```bash
bun run release:assets \
  --version <version> \
  --tag <tag> \
  --sha <commit> \
  --upload
```

Use `--upload-existing` when the candidate already exists and only GitHub upload
must be retried.

## Hard rules

- `VERSION` is the only established-repository version base.
- Projen synthesis projects `VERSION`; publication does not change it.
- One candidate build produces every production registry and binary artifact.
- Local publication and GitHub upload consume that same candidate.
- The Git commit SHA is the release content identity.
- The annotated tag and manifest must resolve to that SHA.
- Publishing the draft GitHub Release is the only production promotion event.
- Production npm publication uses the repository `NPM_TOKEN` directly.
- No Git worktree, Release Please state, component version, component tag,
  source-manifest stamping, binary byte injection, or automatic GitHub rebuild
  belongs in this path.

## Exit criteria

Archive this document after:

1. one release is prepared through the single-checkout transaction;
2. the draft is reviewed and published manually;
3. npm publishes directly with `NPM_TOKEN` and GitHub provenance from the recorded tag and SHA;
4. PyPI, Cargo, binaries, and docs promote from the same release identity;
5. manual dry-run recovery validates the same candidate without rebuilding it.
