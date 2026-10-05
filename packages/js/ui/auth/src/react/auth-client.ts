/**
 * Compatibility exports for the browser client now owned by
 * `@dbx-tools/shared-auth/browser`.
 */

export {
  AUTH_BASE_PATH,
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
} from "@dbx-tools/shared-auth/browser";
export type { Passkey, PasskeyOperation } from "@dbx-tools/shared-auth/browser";
