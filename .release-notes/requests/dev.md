# Release request: dev

Reviewing the release automation changes to draft accurate release-request notes.


## Release notes

### Contributor release flow (independent mode)

- **`bun run release`** on a non-`main` branch (for this repo, typically `dev`) commits pending work, writes reviewer notes under `.release-notes/requests/<branch>.md`, adds a `Release-Request: true` commit, and pushes. It does nothing if the branch matches `main`, has no changes vs the release base, or has no releasable conventional commits (`fix:`, `feat:`, or `BREAKING CHANGE:`).
- **`release-request` GitHub Actions workflow** runs on pushes to non-`main` branches. When the tip commit is a release request, it opens or updates a PR into `main` with a **Release notes** section from that file and turns on **auto-merge** after checks pass.
- After that PR lands, **`release.yml`** continues with Release Please (combined component release PR), affected-unit publication, and docs. **`bun run release:refresh`** still runs Release Please locally for operator recovery.
- Release-request and historical notes under `.release-notes/` and `docs/releases/` are excluded from release-unit and docs-change detection so note-only edits do not start another release.

### Long-lived source branch sync

- When **`releaseSyncBranch`** is set (`dev` here), a successful publication run syncs that branch from **released `main`**: fast-forward if it is behind, no-op if it already contains `main`, otherwise a merge of `main` into the source branch.
- Conflicts limited to generated release metadata (manifests, `release-units`, lockfiles, package versions, barrels, etc.) can be resolved by re-synthesizing with Projen and pushing. Missing branches, handwritten conflicts, or unresolved merges are left alone (warning only, no forced history).

### `@dbx-tools/projen` consumers

- **`versioningMode: "independent"`** generates the release-request workflow, wires root **`release`** to `release-request.ts`, and **`release:refresh`** to `release-please.ts`. The scalar **`VERSION` / `bump`** path stays available only for **`versioningMode: "fixed"`**, which remains the default for downstream workspaces during migration.
- Optional **`releaseSyncBranch`** adds the post-publication sync job described above.

### Compatibility

- No change to published package APIs or runtime behavior; this is **release tooling and CI** only.
- Switching a workspace to independent mode requires Release Please state (`bun run release:bootstrap`) and conventional commits on the source branch. Release requests must not be run from the release base branch (`main` by default).
