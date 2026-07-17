// Re-export of AppKit's React UI kit so the `@dbx-tools/*` UI packages import
// their primitives (Button, Input, cn, etc.) through one stable specifier -
// `@dbx-tools/ui-appkit/react` - and resolve AppKit + React from this package's
// dependencies rather than each consumer's.

export * from "@databricks/appkit-ui/react";
