# RCA: dbx-tools-ai app crash-loop (model-proxy fails to launch)

**Date:** 2026-08-01
**Affected project:** `~/Projects/github-reggie-db/dbx-tools-assistant`
**Severity:** App unusable — full crash-loop, no UI, no proxy.
**Status:** Fixed (uncommitted change in `dbx_tools_ai/model_proxy.py`).

---

## Summary

The `dbx.tools` Electron app would not stay up. On launch, the **model-proxy**
child process exited immediately with code 1, and because the Electron shell
couples all three supervised processes (a crash of any one kills and relaunches
the whole group), the entire app entered a permanent crash-loop and never
presented a working UI or proxy.

The cause was **not** any recent code change in the repo. It was an environment
shift: **Node.js was upgraded to v25.9.0**, and the model-proxy CLI package it
launches ships a **TypeScript** entrypoint that Node ≥23 refuses to execute from
inside `node_modules`.

---

## Symptom

Launch log (`desktop/main.js` supervisor):

```
[model-proxy] exited (code 1, signal null); relaunching group
[model-proxy] exited (code 1, signal null); relaunching group
[model-proxy] exited (code 1, signal null); relaunching group
...
```

Running the entrypoint directly surfaced the real error:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
currently unsupported for files under node_modules, for
".../@dbx-tools/cli-model-proxy@latest/.../bin/dbx-tools-model-proxy.ts"
Node.js v25.9.0
```

---

## Root cause

1. `dbx_tools_ai/model_proxy.py` → `_launch_argv()` launches the published CLI
   `@dbx-tools/cli-model-proxy@latest` (currently `0.6.41`) via `bunx`.
2. That package's bin is a **TypeScript file**,
   `bin/dbx-tools-model-proxy.ts`, with shebang `#!/usr/bin/env node`.
3. `bunx` resolves/stages the package but **honors the `node` shebang**, handing
   the `.ts` file to Node rather than running it under Bun.
4. **Node.js v25.9.0** (recently installed on this machine) only does
   experimental TypeScript type-stripping for *your own* files — it **refuses
   for anything under `node_modules`**, raising
   `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` and exiting 1.
5. The Electron shell's coupled-lifecycle design (replacing launchd `KeepAlive`)
   then relaunches the whole group on that exit → permanent crash-loop.

**Why it "recently broke":** the app bundle (built Jul 30) was fine. What moved
underneath it was the environment — the Node upgrade to v25, and/or the CLI
publishing a `.ts` bin. Either alone is enough to trigger the failure; together
they guarantee it. This is a classic "nothing in the repo changed, but it
stopped working" case.

---

## Fix

`dbx_tools_ai/model_proxy.py`, `_launch_argv()` — force Bun's runtime with
`--bun` so the `node` shebang is ignored and the `.ts` bin runs natively:

```python
# before
bunx = shutil.which("bunx")
if bunx:
    return [bunx, spec, *flags]
npx = shutil.which("npx")
if npx:
    return [npx, "--yes", spec, *flags]
bun = shutil.which("bun") or "/opt/homebrew/bin/bun"
return [bun, "x", spec, *flags]

# after
bunx = shutil.which("bunx")
if bunx:
    return [bunx, "--bun", spec, *flags]
bun = shutil.which("bun") or "/opt/homebrew/bin/bun"
return [bun, "x", "--bun", spec, *flags]
```

The `npx` fallback was **removed**: npx has no `--bun` equivalent, so it would
run the `.ts` bin under node and hit the identical failure — a fallback that
can't work is worse than none.

### Verification

- `bunx --bun @dbx-tools/cli-model-proxy@latest --help` → prints usage (was: node error).
- `python -m dbx_tools_ai.run_model_proxy` → starts, connects to Databricks
  backend, **listens on `:4000`** under `bun`.
- Full `.app` launch → **0 "relaunching group"** events (was 5+ per few seconds);
  service `:6969` and proxy `:4000` both stable.

---

## Follow-ups / things to look at later

- [ ] **Commit the fix** — currently uncommitted in `dbx-tools-assistant`. It sits
      alongside other in-flight work (gemini_cache_guard, kanna-mod sync changes),
      so commit it in isolation with a clear message.
- [ ] **Consider pinning Node**, or at least document the required major version.
      Tracking `@latest` for the CLI + a rolling Node install is a standing risk:
      any future Node major or CLI publish can re-break this the same way.
- [ ] **Upstream the real fix in `@dbx-tools/cli-model-proxy`**: either ship a
      compiled `.js` bin, or change the shebang to `#!/usr/bin/env bun`. The
      `--bun` workaround is a client-side band-aid for a package that publishes a
      `.ts` bin with a `node` shebang.
- [ ] **npx path is now unsupported** — if a machine ever has npx but not bun,
      the proxy won't launch. Acceptable here (bun is always present) but worth a
      note if this is ever run elsewhere.
- [ ] Same failure mode applies to **any other `bunx`-launched `.ts` bin** in the
      app — worth auditing `run_kanna` / other node execs for the same shebang trap.

---

## Timeline (this session)

- Discovered while investigating an unrelated disk-full issue (which turned out
  to be Google Gemini's runaway Clearcut telemetry cache, ~62 GB — a separate
  problem, not related to this crash-loop).
- Reproduced the crash-loop by launching the `.app` directly and capturing the
  supervisor log.
- Isolated to model-proxy via direct entrypoint run; confirmed the Node
  type-stripping error.
- Verified `bunx --bun` runs the same bin cleanly; applied and end-to-end tested.
