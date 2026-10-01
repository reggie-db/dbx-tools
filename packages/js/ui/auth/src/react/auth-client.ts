/**
 * Compatibility exports for the browser client now owned by
 * `@dbx-tools/shared-auth/client`.
 */

export {
  AUTH_BASE,
  addPasskey,
  beginPasskeyEnrollment,
  beginPasskeySignIn,
  cancelPasskeyOperation,
  getAuthStatus,
  listPasskeys,
  logout,
  removePasskey,
  renamePasskey,
  requestEmailOtp,
  signInPasskey,
  verifyEmailOtp,
} from "@dbx-tools/shared-auth/client";
export type { PasskeyOperation, PasskeySummary } from "@dbx-tools/shared-auth/client";
