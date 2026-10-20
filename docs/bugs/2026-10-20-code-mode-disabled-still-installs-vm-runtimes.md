# Disabled Code Mode still installs VM runtimes

Date: 2026-10-20

Status: Reproducible

## Problem

An application configured with `codeMode: false` still encounters Code Mode
transport packages during a clean Bun install of
`@dbx-tools/appkit-mastra@0.9.163`.

The published AppKit-Mastra manifest lists `@mastra/isolated-vm` and
`@mastra/quickjs` as development dependencies. Bun 1.3.14 resolves those
packages during a clean consumer install. `isolated-vm` then runs its native
installation script and fails before the application can start.

Observed failure:

```text
Error: Bun's postinstall script was not run.
error: install script from "isolated-vm" exited with 1
```

This reproduces after deleting both `node_modules` and the ignored local Bun
lockfile, so it is not a stale dependency tree. It also reproduces after
AppKit-Mastra has been configured with `codeMode: false`.

## Impact

- Windows developers cannot reliably run `uv run dev`.
- Clean local or CI recovery can fail while trying to compile an unused native
  VM transport.
- Databricks App staging needs consumer-owned vendor packages solely to prevent
  unused Code Mode dependencies from entering the install graph.
- Applications must maintain packaging policy that belongs to AppKit-Mastra.

## Consumer workaround

RaceTrac currently declares two direct, version-compatible file dependencies:

```json
{
  "@mastra/isolated-vm": "file:./vendor/isolated-vm-disabled",
  "@mastra/quickjs": "file:./vendor/quickjs-disabled"
}
```

Each vendor package uses the real package name and expected version but exports
only an inert module that throws if loaded. The application also keeps
`codeMode: false` and stages both vendor directories for Databricks Apps.

This prevents native VM installation but is application-owned package-manager
scaffolding that should not be required.

## Expected behavior

- `codeMode: false` applications install no isolated-vm or QuickJS runtime.
- Importing and starting AppKit-Mastra does not probe either transport.
- Enabling one transport produces a clear dependency instruction when that
  optional package is absent.
- Clean Bun, npm, and Databricks App installs require no consumer vendor stubs.

## Proposed fix

1. Keep Code Mode transports out of the published default runtime dependency
   graph.
2. Model each transport as an optional peer or separate opt-in package.
3. Dynamically import a transport only after configuration selects it.
4. Ensure the published consumer manifest does not expose development-only
   native transports in a way Bun installs transitively.
5. Add clean-consumer fixtures for Bun on Windows and Linux plus npm in the
   Databricks App container shape.

## Tests

- Clean Bun install with `codeMode: false` contains neither transport.
- Clean npm install with `codeMode: false` contains neither transport.
- AppKit-Mastra imports and starts without either package.
- Selecting isolated-vm without its optional package returns an actionable
  configuration error.
- Selecting QuickJS without its optional package returns an actionable
  configuration error.
- A Windows clean-install fixture does not run native Code Mode postinstall
  scripts.
