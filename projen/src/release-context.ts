/** Verified release context shared by every job in the unified workflow. */
/** Version verified by the shared build that produced every publication artifact. */
export const RELEASE_VERSION = "${{ needs.build-release.outputs.release_version }}";
/** Generated GitHub Actions workflow triggered by release tags. */
export const RELEASE_WORKFLOW_FILE = "release.yml";
/** Environment applied to release dependency installation and synthesis. */
export const RELEASE_INSTALL_ENV = {
  ONNXRUNTIME_NODE_INSTALL: "skip",
} as const;
/** Public npm registry queried after npm publication completes. */
export const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org";
/** Public PyPI JSON API queried after Python publication completes. */
export const PUBLIC_PYPI_REGISTRY_URL = "https://pypi.org/pypi";
/** Shared wait for every unresolved public npm and PyPI artifact. */
export const PUBLICATION_WAIT_TIMEOUT_SECONDS = 20 * 60;
/** Delay between public registry probes while a release is still invisible. */
export const PUBLICATION_WAIT_INTERVAL_SECONDS = 5;
/** Maximum duration of one public registry request before the next poll can proceed. */
export const PUBLICATION_REQUEST_TIMEOUT_SECONDS = 10;
