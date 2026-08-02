/**
 * Email brand compatibility exports.
 *
 * The universal brand contract and defaults live with the shared React Email
 * template so Node delivery and browser previews cannot drift.
 *
 * @module
 */
export {
  defaultEmailBrand,
  emailBrandFromContext,
  resolveEmailBrand,
} from "@dbx-tools/shared-email-template";
export type { EmailBrand, ResolvedEmailBrand } from "@dbx-tools/shared-email-template";
