/**
 * Universal React Email presentation for dbx-tools email flows.
 *
 * The document component renders on the server through `@react-email/render`;
 * the body component is reused directly by browser approval and compose views.
 * Both default to the repository brand while accepting a consumer override.
 *
 * @module
 */
import { brand, type BrandContext } from "@dbx-tools/shared-core";
import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Markdown,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

/** Email-safe brand values used by the React Email template. */
export interface EmailBrand {
  accent: string;
  onAccent?: string;
  fontFamily: string;
  name?: string;
  logoUrl?: string;
  background?: string;
  surface?: string;
  foreground?: string;
  muted?: string;
  border?: string;
  tagline?: string;
  website?: string;
}

/** Complete values after applying the dbx-tools default brand. */
export type ResolvedEmailBrand = Required<
  Pick<
    EmailBrand,
    | "accent"
    | "onAccent"
    | "fontFamily"
    | "name"
    | "background"
    | "surface"
    | "foreground"
    | "muted"
    | "border"
    | "tagline"
  >
> &
  Pick<EmailBrand, "logoUrl" | "website">;

function isRenderableImageUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^(?:https?:|data:|cid:)/i.test(value);
}

/** Project a portable brand context into email-safe values. */
export const emailBrandFromContext = (context: BrandContext): EmailBrand => {
  const logo = context.assets.logo.dark ?? context.assets.logo.light;
  return {
    accent: context.colors.primary,
    onAccent: "#ffffff",
    fontFamily: context.typography.sans,
    name: context.name,
    background: context.colors.surface,
    surface: context.colors.background,
    foreground: context.colors.foreground,
    muted: context.colors.muted,
    border: context.colors.border,
    tagline: context.tagline,
    website: context.links.website,
    ...(isRenderableImageUrl(logo) ? { logoUrl: logo } : {}),
  };
};

/** The repository brand used by every email unless explicitly overridden. */
export const defaultEmailBrand: EmailBrand = emailBrandFromContext(brand.defaultBrandContext);

/** Merge a partial consumer brand over the repository default. */
export const resolveEmailBrand = (input?: EmailBrand): ResolvedEmailBrand => {
  const merged = { ...defaultEmailBrand, ...input };
  return {
    accent: merged.accent,
    onAccent: merged.onAccent ?? "#ffffff",
    fontFamily: merged.fontFamily,
    name: merged.name ?? brand.defaultBrandContext.name,
    background: merged.background ?? brand.defaultBrandContext.colors.surface,
    surface: merged.surface ?? brand.defaultBrandContext.colors.background,
    foreground: merged.foreground ?? brand.defaultBrandContext.colors.foreground,
    muted: merged.muted ?? brand.defaultBrandContext.colors.muted,
    border: merged.border ?? brand.defaultBrandContext.colors.border,
    tagline: merged.tagline ?? brand.defaultBrandContext.tagline,
    ...(merged.logoUrl ? { logoUrl: merged.logoUrl } : {}),
    ...(merged.website ? { website: merged.website } : {}),
  };
};

/** Normalize indentation in authored content without constraining its structure. */
export const normalizeEmailMarkdown = (value: string): string => {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const nonBlank = lines.filter((line) => line.trim().length > 0);
  const indent = nonBlank.reduce((minimum, line) => {
    const width = line.match(/^\s*/)?.[0].length ?? 0;
    return Math.min(minimum, width);
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(indent) || indent === 0) return lines.join("\n");
  return lines.map((line) => line.slice(Math.min(indent, line.length))).join("\n");
};

/** Props for the reusable message-body component. */
export interface EmailBodyProps {
  body: string;
  brand?: EmailBrand;
}

/** Render rich message content with email-client-safe inline styles. */
export const EmailBody = ({ body, brand: brandInput }: EmailBodyProps) => {
  const theme = resolveEmailBrand(brandInput);
  return (
    <Markdown
      markdownContainerStyles={{
        color: theme.foreground,
        fontFamily: theme.fontFamily,
        fontSize: "15px",
        lineHeight: "1.65",
      }}
      markdownCustomStyles={{
        h1: { color: theme.foreground, fontSize: "30px", lineHeight: "1.2", margin: "0 0 20px" },
        h2: { color: theme.foreground, fontSize: "23px", lineHeight: "1.3", margin: "28px 0 12px" },
        h3: { color: theme.foreground, fontSize: "18px", lineHeight: "1.4", margin: "24px 0 10px" },
        p: { margin: "0 0 16px" },
        link: { color: theme.accent, fontWeight: 600, textDecoration: "underline" },
        blockQuote: {
          backgroundColor: theme.background,
          borderLeft: `4px solid ${theme.accent}`,
          borderRadius: "0 10px 10px 0",
          color: theme.foreground,
          margin: "20px 0",
          padding: "14px 18px",
        },
        codeInline: {
          backgroundColor: theme.background,
          borderRadius: "5px",
          color: theme.foreground,
          fontFamily: brand.defaultBrandContext.typography.mono,
          fontSize: "13px",
          padding: "2px 5px",
        },
        codeBlock: {
          backgroundColor: theme.foreground,
          borderRadius: "10px",
          color: theme.surface,
          fontFamily: brand.defaultBrandContext.typography.mono,
          fontSize: "13px",
          lineHeight: "1.55",
          margin: "20px 0",
          padding: "16px",
        },
        hr: { borderColor: theme.border, margin: "28px 0" },
        image: { borderRadius: "10px", height: "auto", maxWidth: "100%" },
        li: { margin: "6px 0" },
        table: { borderCollapse: "collapse", margin: "20px 0", width: "100%" },
        th: {
          backgroundColor: theme.background,
          border: `1px solid ${theme.border}`,
          padding: "9px 12px",
          textAlign: "left",
        },
        td: {
          border: `1px solid ${theme.border}`,
          padding: "9px 12px",
          textAlign: "left",
        },
      }}
    >
      {normalizeEmailMarkdown(body)}
    </Markdown>
  );
};

/** Props for the complete React Email document. */
export interface EmailDocumentProps extends EmailBodyProps {
  subject?: string;
  headers?: ReadonlyArray<readonly [string, string]>;
  footer?: string;
  /**
   * Preheader text: the snippet a client shows next to the subject in a list, and
   * - the reason this is a prop - the text a mobile OS puts in the PUSH
   * NOTIFICATION body.
   *
   * Defaults to the subject. Set it when the notification should say something the
   * subject does not. One-time-code mail is the case that motivated it: iOS reads
   * an incoming notification's text to offer an autofill code (natively for Mail
   * and Messages, and since iOS 26 for any app's notification, Gmail included), so
   * a code that appears only in the BODY is never seen - the notification carries
   * the subject and this snippet, nothing more.
   */
  preview?: string;
}

function BrandMark({ theme }: { theme: ResolvedEmailBrand }): React.ReactNode {
  if (theme.logoUrl) {
    return (
      <Img
        src={theme.logoUrl}
        alt={theme.name}
        height="34"
        style={{ display: "block", height: "34px", width: "auto" }}
      />
    );
  }
  return (
    <Text
      style={{
        color: theme.onAccent,
        fontSize: "20px",
        fontWeight: 800,
        letterSpacing: "-0.3px",
        margin: 0,
      }}
    >
      {theme.name}
    </Text>
  );
}

function EnvelopeHeaders({
  headers,
  theme,
}: {
  headers: EmailDocumentProps["headers"];
  theme: ResolvedEmailBrand;
}) {
  if (!headers?.length) return null;
  return (
    <Section
      style={{
        backgroundColor: theme.background,
        borderRadius: "10px",
        margin: "0 0 24px",
        padding: "14px 16px",
      }}
    >
      {headers.map(([label, value]) => (
        <Row key={`${label}:${value}`}>
          <Column
            style={{
              color: theme.muted,
              fontSize: "12px",
              fontWeight: 700,
              padding: "3px 12px 3px 0",
              width: "70px",
            }}
          >
            {label}
          </Column>
          <Column style={{ color: theme.foreground, fontSize: "13px", padding: "3px 0" }}>
            {value}
          </Column>
        </Row>
      ))}
    </Section>
  );
}

/** Branded message card shared by the full document and browser previews. */
export const EmailCard = ({
  body,
  subject = "Message",
  headers,
  footer,
  brand: brandInput,
}: EmailDocumentProps) => {
  const theme = resolveEmailBrand(brandInput);
  return (
    <Container
      style={{
        backgroundColor: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: "16px",
        boxShadow: "0 8px 30px rgba(27,49,57,0.08)",
        fontFamily: theme.fontFamily,
        margin: "0 auto",
        maxWidth: "620px",
        overflow: "hidden",
      }}
    >
      <Section style={{ backgroundColor: theme.accent, padding: "22px 30px" }}>
        <BrandMark theme={theme} />
      </Section>
      <Section style={{ padding: "34px 34px 24px" }}>
        <Heading
          style={{
            color: theme.foreground,
            fontSize: "28px",
            letterSpacing: "-0.5px",
            lineHeight: "1.2",
            margin: "0 0 24px",
          }}
        >
          {subject}
        </Heading>
        <EnvelopeHeaders headers={headers} theme={theme} />
        <EmailBody body={body} brand={theme} />
      </Section>
      <Hr style={{ borderColor: theme.border, margin: 0 }} />
      <Section style={{ padding: "20px 34px 26px" }}>
        <Text
          style={{
            color: theme.muted,
            fontSize: "12px",
            lineHeight: "1.55",
            margin: 0,
          }}
        >
          {footer ?? theme.tagline}{" "}
          {theme.website ? (
            <Link
              href={theme.website}
              style={{
                color: theme.accent,
                textDecoration: "none",
              }}
            >
              {theme.name}
            </Link>
          ) : null}
        </Text>
      </Section>
    </Container>
  );
};

/** Complete responsive, branded React Email document. */
export const EmailDocument = (props: EmailDocumentProps) => {
  const theme = resolveEmailBrand(props.brand);
  const pageStyle: React.CSSProperties = {
    backgroundColor: theme.background,
    fontFamily: theme.fontFamily,
    margin: 0,
    padding: "28px 12px",
  };
  return (
    <Html lang="en">
      <Head />
      <Preview>{props.preview ?? props.subject ?? "Message"}</Preview>
      <Body style={pageStyle}>
        <EmailCard {...props} />
      </Body>
    </Html>
  );
};
