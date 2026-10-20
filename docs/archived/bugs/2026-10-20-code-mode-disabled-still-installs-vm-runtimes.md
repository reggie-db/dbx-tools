# Disabled Code Mode still installs VM runtimes

Date: 2026-10-20

Status: Resolved

## Problem

`@dbx-tools/appkit-mastra` published `@mastra/isolated-vm` and
`@mastra/quickjs` as optional dependencies. Package managers therefore included
both transports in clean consumer installations even when applications set
`codeMode: false`. The transitive `isolated-vm` native installation could fail
before the application started.

Runtime selection was already lazy. Disabled Code Mode returned before probing
either transport, and an explicitly selected missing transport produced an
actionable installation error.

## Resolution

Both transports are now optional peer dependencies. AppKit-Mastra retains them
as development dependencies for compilation and transport tests, but clean
consumers no longer install either package unless they opt in.

The package manifest test verifies that each transport:

- Is absent from runtime and optional dependencies.
- Is an optional peer dependency.
- Remains a development dependency.

The existing disabled Code Mode test verifies that no Code Mode execution tool
is registered when `codeMode: false`.
