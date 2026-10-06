/** Verified release context shared by every job in the unified workflow. */
/** Version verified by the shared build that produced every publication artifact. */
export const RELEASE_VERSION = "${{ needs.build-release.outputs.release_version }}";
