// Compact, muted Markdown renderer for an email body. Shared by the
// read-only approval preview and the compose view's live preview so both
// render the drafted Markdown identically (links, lists, emphasis, and
// tables rather than raw syntax).

import { cn } from "@databricks/appkit-ui/react";
import { EmailBody as SharedEmailBody, type EmailBrand } from "@dbx-tools/shared-email-template";

/** Props for {@link EmailBody}. */
export interface EmailBodyProps {
  children: string;
  /** Extra classes merged onto the prose container. */
  className?: string;
  /** Optional brand override; dbx-tools branding is the default. */
  brand?: EmailBrand;
}

/** Render an email body with the same React Email component used for delivery. */
export const EmailBody = ({ children, className, brand }: EmailBodyProps) => (
  <div className={cn("max-w-none break-words", className)}>
    <SharedEmailBody body={children} brand={brand} />
  </div>
);
