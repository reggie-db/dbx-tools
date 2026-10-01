/**
 * Co-tested Projen release used by the engine and every generated project.
 *
 * The engine exposes Projen as a peer dependency so consumers and generated
 * projects share one runtime instance. Keep the peer range and generated
 * development dependency on this single value; duplicate Projen instances can
 * break its remaining `instanceof`-based file detection.
 */
export const PROJEN_VERSION = "^0.103.27";
