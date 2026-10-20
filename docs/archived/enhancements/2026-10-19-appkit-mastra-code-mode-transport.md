# Configure AppKit Mastra Code Mode transport explicitly

Date: 2026-10-19

Status: Implemented and archived 2026-10-19

## Problem

`@dbx-tools/appkit-mastra` currently enables Mastra Code Mode whenever an agent
has executable tools. The package declares `@mastra/isolated-vm` as an optional
dependency, prefers that transport on eligible Linux Node runtimes, and falls
back to `@mastra/quickjs` elsewhere or when the native import fails.

Code Mode should require explicit activation because it adds an executable
orchestration tool to every eligible agent. Both transports must also remain
optional so their runtime engine requirements do not become hard requirements
of `@dbx-tools/appkit-mastra`.

## Requirements

- Default `codeMode` to `false`.
- Publish both transports only as optional and development dependencies.
- Check each selected optional dependency at runtime at most once.
- Use Vite-ignored dynamic imports so bundlers do not require unselected
  transports.
- Let consumers select automatic, required isolated-vm, or QuickJS execution.
- Fail plugin startup when required isolated-vm cannot be used.
- Let automatic mode try isolated-vm, then QuickJS, then disable Code Mode when
  no supported optional transport can run.
- Never attempt to import isolated-vm in QuickJS mode.
- Preserve existing tool filtering, request-context propagation, generated
  tool id, timeout, instructions, and workspace-tool behavior.
- Log the selected transport and automatic fallback reason without logging
  source code, tool inputs, or credentials.

## Proposed API

Use the implementation names as the public transport values. `quickjs` is more
precise than `local` or `file`: it selects Mastra's in-process QuickJS transport.
Filesystem access remains available only through exposed workspace tools.

```ts
export type MastraCodeModeTransport = "auto" | "isolated-vm" | "quickjs";

export interface MastraCodeModeConfig {
  /** Code Mode execution transport. */
  transport: MastraCodeModeTransport;
  /** Generated orchestration tool id. Defaults to `execute_typescript`. */
  id?: string;
  /** Maximum orchestration program runtime in milliseconds. Defaults to 30 seconds. */
  timeout?: number;
}

export interface MastraPluginConfig {
  codeMode?: false | MastraCodeModeTransport | MastraCodeModeConfig;
}
```

Examples:

```ts
// Default: do not expose execute_typescript.
mastra({});

// Prefer isolated-vm, then QuickJS, and stay disabled when neither can run.
mastra({ codeMode: "auto" });

// Require isolated-vm and fail startup when it is unavailable or unsupported.
mastra({ codeMode: "isolated-vm" });

// Require the optional portable transport without probing isolated-vm.
mastra({ codeMode: "quickjs" });

// Configure the transport and existing Code Mode options together.
mastra({
  codeMode: {
    transport: "quickjs",
    id: "execute_typescript",
    timeout: 30_000,
  },
});
```

Do not retain `true` as a second spelling for `auto`. Update every in-repository
consumer to an explicit transport or `false` in the same change.

## Transport behavior

### `false`

- This is the default when `codeMode` is omitted.
- Do not create the Code Mode resolver or expose the generated orchestration
  tool.
- Do not probe or import either transport.

### `quickjs`

- Check QuickJS runtime support, then import and construct it during startup.
- Do not inspect isolated-vm runtime eligibility.
- Do not import `@mastra/isolated-vm`.
- Fail startup when QuickJS is unsupported, unavailable, or cannot initialize.

### `auto`

- Check the existing isolated-vm runtime constraints before importing it.
- When the runtime is eligible, attempt the dynamic
  `@mastra/isolated-vm` import once during plugin startup.
- Select isolated-vm when the import and transport construction succeed.
- Try QuickJS when isolated-vm is ineligible, absent, or cannot initialize.
- Leave Code Mode disabled when QuickJS is also unsupported, absent, or cannot
  initialize.
- Log the fallback category and normalized error for import or construction
  failures.

### `isolated-vm`

- Check runtime eligibility during plugin startup.
- Import and construct `@mastra/isolated-vm` during plugin startup.
- Raise a configuration error when the runtime is unsupported, the dependency
  is missing, or transport construction fails.
- Include the required installation command in the missing-dependency error:

  ```text
  bun add @mastra/isolated-vm
  ```

- Do not fall back to QuickJS.

## Dependency ownership

Update the Projen source of truth for `appkit-mastra` so both
`@mastra/isolated-vm` and `@mastra/quickjs` are optional dependencies plus
development dependencies for compile-time types and focused tests. Neither is a
hard runtime dependency. Consumers may omit optional dependencies or install a
selected transport directly.

## Implementation

1. Replace the global transport promise with startup-time transport resolution
   keyed by the normalized configured mode.
2. Normalize string and object configuration into one internal structure
   containing `transport`, `id`, and `timeout`.
3. Resolve configured transports during plugin startup so required-mode errors
   occur before the app accepts requests.
4. Pass the resolved transport into agent construction instead of selecting it
   lazily from `buildCodeMode()`.
5. Keep per-request tool collection and `createCodeMode()` construction lazy so
   request-scoped tools and workspace policy remain current.
6. Update the AppKit plugin configuration schema and generated descriptions to
   include the string values and the new default.
7. Update examples and in-repository consumers that rely on the current
   implicit enablement.
8. Regenerate package manifests from `.projenrc.ts` and verify that published
   `appkit-mastra` metadata contains no hard Code Mode transport dependency.

## Tests

- Omitted `codeMode` exposes no `execute_typescript` tool.
- `codeMode: false` exposes no Code Mode tool and imports no transport.
- `quickjs` selects QuickJS and does not attempt the isolated-vm import.
- `auto` selects isolated-vm on an eligible runtime with the dependency
  installed.
- `auto` selects QuickJS when isolated-vm cannot run and disables Code Mode when
  QuickJS also cannot run.
- `isolated-vm` fails startup for each unsupported or unavailable condition.
- String and object configurations preserve custom `id` and `timeout` values.
- Dynamic request tools and workspace tools remain available through the
  selected transport.
- The generated package manifest keeps both transports out of `dependencies`
  and retains them in `optionalDependencies` and `devDependencies`.

## Acceptance criteria

- `@dbx-tools/appkit-mastra` does not impose either transport's engine range as
  a hard dependency requirement.
- Apps that do not configure Code Mode expose no executable orchestration tool.
- QuickJS mode works on supported Node and Bun hosts without isolated-vm.
- Required isolated-vm mode fails during startup with an actionable error.
- Automatic mode records selected transports and fallback reasons, and exposes
  no Code Mode tool when neither optional transport can run.
