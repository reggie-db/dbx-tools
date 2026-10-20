/** Verified release context shared by every job in the unified workflow. */
/** Version verified by the shared build that produced every publication artifact. */
export const RELEASE_VERSION = "${{ needs.build-release.outputs.release_version }}";
/** Generated GitHub Actions workflow triggered by release tags. */
export const RELEASE_WORKFLOW_FILE = "release.yml";
