# @dbx-tools/shared-email-template

Render the same React Email presentation in server-delivered messages and
browser previews. The package owns the branded document, card, body, and brand
mapping without depending on Databricks AppKit, SMTP, or DOM APIs.

## Quick start

Render the same branded document in SMTP delivery and browser previews:

```tsx
import { EmailDocument } from "@dbx-tools/shared-email-template";

<EmailDocument subject="Incident update" body="## Resolved\nAll systems are healthy." />;
```

The exported components cover:

- Responsive React Email document with email-safe inline styling.
- Reusable message-body component for approval and compose previews.
- dbx-tools branding applied by default through `BrandContext`.
- Consumer brand overrides without coupling templates to AppKit or SMTP.
- Rich content rendered consistently in the inbox and browser.

## Runtime boundary

This package provides presentation only:

- [@dbx-tools/email](../../node/email) renders `EmailDocument` for SMTP and
  local outbox delivery.
- [@dbx-tools/ui/email](../../ui/appkit) uses `EmailBody` and `EmailCard` for
  approval, compose, and preview surfaces.
- [@dbx-tools/shared-email](../email) owns email wire schemas without taking a
  React dependency.

The package doesn't send messages, approve delivery, access AppKit request
identity, or require browser DOM APIs.

## Configure the template

```tsx
import { EmailDocument } from "@dbx-tools/shared-email-template";

<EmailDocument subject="Incident update" body="## Resolved\nAll systems are healthy." />;
```

Node runtimes should pass this component to `@react-email/render`.
`@dbx-tools/email` does that automatically for SMTP and local outbox delivery.

`heading` defaults to the MIME subject. Pass a shorter heading when the subject
carries notification-specific details. One-time-code mail uses this to keep the
code in notifications without repeating it inside the opened card:

```tsx
<EmailDocument
  subject="123456 is your verification code"
  heading="Your verification code"
  preview="Your verification code is: 123456"
  body={body}
/>
```

`preview` sets the preheader, which is the snippet a client shows beside the
subject and the body of the push notification a mobile mail app posts. It
defaults to the subject. Set it when the notification should say something the
subject does not:

```tsx
<EmailDocument
  subject="123456 is your verification code"
  preview="Your verification code is: 123456"
  body={body}
/>
```

Mobile one-time-code autofill can read the code from the notification's sender,
subject, and preheader. A code that appears only in the message body doesn't
reach the autofill heuristics.

## Reuse the body preview

```tsx
import { EmailBody } from "@dbx-tools/shared-email-template";

<EmailBody body={draft.body} />;
```

The body preview and complete document share typography and content styling. The
full document adds the branded header band, heading, and footer.
Envelope rows (`headers`) are opt-in for local outbox previews. Delivered SMTP
mail and browser approval chrome leave recipients and attachments outside the
HTML body.

Use `EmailCard` when a browser surface should show that complete presentation
without rendering an outer `<html>` or `<body>` element:

```tsx
import { EmailCard } from "@dbx-tools/shared-email-template";

<EmailCard subject={draft.subject} body={draft.body} />;
```

## Apply a brand

```ts
import { brandUtils } from "@dbx-tools/shared-core";
import { emailBrandFromContext } from "@dbx-tools/shared-email-template";

const emailBrand = emailBrandFromContext(brandUtils.defaultBrandContext);
```

Omitting `brand` uses the dbx-tools brand. A consumer may supply its own colors,
font, name, tagline, website, and fetchable logo URL. The footer renders a
tagline only when the supplied brand declares one.

## Package exports

- `.`: `EmailDocument`, `EmailCard`, `EmailBody`, brand types/defaults, and
  content normalization.

Pair this package with [@dbx-tools/shared-email](../email) for wire schemas,
[@dbx-tools/email](../../node/email) for delivery, and
[@dbx-tools/ui/email](../../ui/appkit) for approval and compose UI.
