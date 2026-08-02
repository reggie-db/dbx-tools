# @dbx-tools/shared-email-template

Universal React Email presentation shared by dbx-tools server and browser email
surfaces.

Key features:

- Responsive React Email document with email-safe inline styling.
- Reusable message-body component for approval and compose previews.
- Repository branding applied by default through `BrandContext`.
- Consumer brand overrides without coupling templates to AppKit or SMTP.
- Rich content rendered consistently in the inbox and browser.

## Why A Separate Package

The presentation layer has two consumers with incompatible dependency needs, so
it lives on its own:

- `@dbx-tools/email` is a Node/AppKit package: it depends on
  `@databricks/appkit` and `nodemailer`. Templates that lived there could not be
  imported by a browser bundle.
- `@dbx-tools/shared-email` is a pure zod contract package consumed by
  non-AppKit callers such as `@dbx-tools/cli-tunnel`. Templates that lived there
  would push React and `@react-email/components` onto every schema consumer.
- `@dbx-tools/ui-email` is a React/DOM package. Templates that lived there would
  make the Node renderer depend on a DOM-typed package.

This package depends on neither AppKit nor SMTP nor the DOM, so any runtime that
can render React can produce the same branded email — including callers outside
AppKit entirely.

## Render The Shared Template

```tsx
import { EmailDocument } from "@dbx-tools/shared-email-template";

<EmailDocument subject="Incident update" body="## Resolved\nAll systems are healthy." />;
```

Node runtimes should pass this component to `@react-email/render`.
`@dbx-tools/email` does that automatically for SMTP and local outbox delivery.

`preview` sets the preheader — the snippet a client shows beside the subject, and
the body of the push notification a mobile mail app posts. It defaults to the
subject; set it when the notification should say something the subject does not:

```tsx
<EmailDocument
  subject="123456 is your verification code"
  preview="Your verification code is: 123456"
  body={body}
/>
```

That pairing is what makes mobile one-time-code autofill work at all: a
notification carries the sender, the subject, and this snippet, so a code found
only in the body never reaches the autofill heuristics.

## Reuse The Body Preview

```tsx
import { EmailBody } from "@dbx-tools/shared-email-template";

<EmailBody body={draft.body} />;
```

The body preview and complete document share typography and content styling. The
full document adds the branded header, subject, envelope metadata, and footer.

Use `EmailCard` when a browser surface should show that complete presentation
without rendering an outer `<html>` or `<body>` element:

```tsx
import { EmailCard } from "@dbx-tools/shared-email-template";

<EmailCard subject={draft.subject} body={draft.body} headers={[["To", draft.to.join(", ")]]} />;
```

## Apply A Brand

```ts
import { brand } from "@dbx-tools/shared-core";
import { emailBrandFromContext } from "@dbx-tools/shared-email-template";

const emailBrand = emailBrandFromContext(brand.defaultBrandContext);
```

Omitting `brand` uses the dbx-tools brand. A consumer may supply its own colors,
font, name, tagline, website, and fetchable logo URL.

## Modules

- `.` - `EmailDocument`, `EmailCard`, `EmailBody`, brand types/defaults, and
  content normalization.

Pair this package with [`@dbx-tools/shared-email`](../email) for wire schemas,
[`@dbx-tools/email`](../../node/email) for delivery, and
[`@dbx-tools/ui-email`](../../ui/email) for approval and compose UI.
