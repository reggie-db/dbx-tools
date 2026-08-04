// Re-export of AppKit's React UI kit so the `@dbx-tools/*` UI packages import
// their primitives (Button, Input, cn, etc.) through one stable specifier -
// `@dbx-tools/ui-appkit/react` - and resolve AppKit + React from this package's
// dependencies rather than each consumer's.
//
// This lives in a NAMED module (not the `index.ts` barrel) so package discovery
// - which ignores barrels + `.css` - still sees `ui-appkit` as a real package.

export * from "@databricks/appkit-ui/react";
