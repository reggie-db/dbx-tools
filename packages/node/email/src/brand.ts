/**
 * Optional brand styling for outbound email. {@link EmailBrand} is the
 * small, email-safe slice of a brand a message actually needs - an accent
 * color, a font stack, a display name, and an optional logo image - and
 * {@link emailBrandFromContext} derives it from the portable `BrandContext`
 * shared across the UI and libraries.
 *
 * Email can't use the `[data-brand]` CSS bridge the browser UI uses (mail
 * clients strip `<style>` blocks and ignore `var()`), so branding is applied
 * by inlining these values at render time. A logo is only emitted when it's
 * a fetchable `http(s):` or `data:` URL - a package-export path (the default
 * asset form) can't resolve in an inbox, so it's dropped rather than shown
 * as a broken image.
 *
 * @module
 */
import { brand, type BrandContext } from "@dbx-tools/shared-core";

/** Email-safe brand values inlined into the message layout at render time. */
export interface EmailBrand {
  /** Header-band background and link color. */
  accent: string;
  /** Text and logo color rendered on the accent band. Defaults to white. */
  onAccent?: string;
  /** Body font stack. */
  fontFamily: string;
  /** Product/display name, used as the header text and the logo `alt`. */
  name?: string;
  /**
   * Logo image rendered in the header band. Only an `http(s):` or `data:`
   * URL renders; other values (e.g. a package-export path) are ignored,
   * since they can't load in a mail client.
   */
  logoUrl?: string;
}

/** Whether `value` is an image reference a mail client can actually load. */
function isRenderableImageUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^(?:https?:|data:)/i.test(value);
}

/**
 * Derive the email-safe {@link EmailBrand} from a full brand context: the
 * primary color as the accent, the sans font stack, the display name, and
 * the dark-surface logo (the header band is dark) when it's a renderable URL.
 */
export function emailBrandFromContext(context: BrandContext): EmailBrand {
  const logo = context.assets.logo.dark ?? context.assets.logo.light;
  return {
    accent: context.colors.primary,
    onAccent: "#ffffff",
    fontFamily: context.typography.sans,
    name: context.name,
    ...(isRenderableImageUrl(logo) ? { logoUrl: logo } : {}),
  };
}

/**
 * The dbx-tools brand as an {@link EmailBrand}, ready to pass to the email
 * plugin (`email({ brand: defaultEmailBrand })`). Convenience so a consumer
 * needs only `@dbx-tools/email`, not the shared brand context, for the
 * common case of the default brand.
 */
export const defaultEmailBrand: EmailBrand = emailBrandFromContext(brand.defaultBrandContext);
