# Native Code Mode transport blocks unsupported local installations

Status: Open

## Summary

`@dbx-tools/appkit-mastra` supports a portable QuickJS Code Mode transport and
an accelerated `isolated-vm` transport for compatible deployments. The native
transport is currently declared as an unconditional runtime dependency even
though the implementation selects it only on compatible Linux and Node
runtimes.

This dependency scope makes an optional acceleration feature a prerequisite
for installing and starting the application. A local development machine can
therefore fail during installation before the existing lazy runtime fallback
to QuickJS has an opportunity to run.

## Customer report

- Operating system: Windows
- Node.js: `26.1.0`
- Application package manager command: `npm install`
- Reported native dependency failure: `isolated-vm` required Node headers, but
  the header download failed because the certificate issuer was not trusted.

After the failed install, application startup reported:

```text
Error: Cannot find package
'C:\...\node_modules\picocolors\index.js' imported from
'C:\...\node_modules\@databricks\appkit\dist\errors\configuration.js'
```

The later `picocolors` error is consistent with an incomplete or damaged
`node_modules` tree. `@databricks/appkit` already declares `picocolors`; adding
another direct `picocolors` dependency would hide the installation failure
rather than fix its cause.

## Current scope mismatch

`appkit-mastra` currently has both of these behaviors:

1. `@mastra/isolated-vm` is an unconditional package dependency, which makes
   its native `isolated-vm` dependency part of every consumer installation.
2. Runtime selection is already lazy and rejects unsupported environments,
   including Windows and Node major versions `25` or newer, before dynamically
   importing `@mastra/isolated-vm`.

Node `26.1.0` can never select the native transport under the current runtime
policy, but installation still attempts to build it. The package boundary and
the runtime boundary therefore disagree.

The feature may work in a compatible deployed Databricks App while preventing
the same project from being installed on a developer workstation. Local
development must not require a native transport that the local runtime cannot
use.

## Required remediation

1. Remove `@mastra/isolated-vm` from the unconditional runtime dependencies of
   `@dbx-tools/appkit-mastra`.
2. Publish it through an optional dependency mechanism that does not make a
   failed native build fail the base package installation. Keep it available as
   a development dependency for type checking and transport-specific tests.
3. Resolve the optional package only when Code Mode is enabled, the runtime is
   eligible for the native transport, and transport selection is first needed.
   Do not add a top-level import, re-export, or startup probe that makes module
   availability an application-start requirement.
4. If the optional package is absent, fails to load, or cannot initialize its
   native binding, select QuickJS and log the selected transport once. Do not
   register or expose the unavailable native transport.
5. Preserve native transport use in compatible deployments when the optional
   package and binding are available. The fix must degrade capability, not
   disable the acceleration path globally.
6. Keep dependency failure diagnostics scoped to Code Mode transport
   selection. Do not recommend a Node upgrade or a direct `picocolors`
   dependency when the application can operate with QuickJS.

If the package manager cannot reliably make a transitive native package
failure non-fatal through `optionalDependencies`, use an optional peer plus a
documented deployment opt-in instead. In either shape, the base package must
install and start without `@mastra/isolated-vm`.

## Recommended implementation plan

1. In `.projenrc.ts`, remove `@mastra/isolated-vm@catalog:` from the
   `appkit-mastra` `p.addDeps(...)` call.
2. Add it to the same generated package as a Projen optional dependency and a
   development dependency:

   ```ts
   import { Component, DependencyType, javascript } from "projen";

   p.deps.addDependency("@mastra/isolated-vm@catalog:", DependencyType.OPTIONAL);
   p.addDevDeps("@mastra/isolated-vm@catalog:");
   ```

   The generated `package.json` must place the package under
   `optionalDependencies`, not `dependencies`. Keep
   `root.pnpmWorkspace.allowBuild("isolated-vm")` so compatible installs are
   still permitted to build the native binding.
3. Keep `QuickJsCodeModeTransport` as the portable baseline. Preserve the
   existing environment eligibility check and literal dynamic `import()` in
   `codeModeTransport()`; do not move the optional import to module scope.
4. Add package-boundary tests that inspect the generated manifest and fail if
   `@mastra/isolated-vm` returns to unconditional dependencies.
5. Add runtime tests for an eligible environment where the optional import is
   missing or throws during native initialization. Both cases must return one
   cached `QuickJsCodeModeTransport` selection rather than fail plugin startup.
6. Regenerate with `bunx projen`, update the workspace lockfile, and verify the
   packed package manifest before release.

## Acceptance tests

- A clean install succeeds on Windows with Node `26.1.0` when
  `@mastra/isolated-vm` is unavailable or its native build cannot run.
- Importing and starting `@dbx-tools/appkit-mastra` on that machine does not
  resolve or load `@mastra/isolated-vm`.
- Code Mode selects QuickJS and remains usable when the native package is not
  installed.
- A compatible Linux deployment with the optional package installed selects
  `IsolatedVmCodeModeTransport` under the existing eligibility policy.
- A compatible Linux deployment without the optional package starts normally,
  logs the QuickJS fallback, and keeps Code Mode usable.
- Disabling Code Mode does not probe `@mastra/isolated-vm`.
- A failed or interrupted install is reported as such; no direct dependency is
  added solely to mask missing files from the partial `node_modules` tree.
