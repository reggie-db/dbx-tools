# Buck2 development

This experimental branch replaces the project generator with explicit Buck2
package macros. Builds, dependency fetching, code generation, and tests are
targets. There is no package discovery service and no publication workflow.

## Boundaries

The source tree has no npm/Python project manifests, `requirements.txt`, pip
configuration, or `index.ts` entry points. Dependencies are declared in BUCK.
Bun's package manifests and installed dependency metadata exist only in ignored
build outputs. Python requirements lock data is not pip configuration.

Networked dependency resolution is not reproducible by itself. Tool versions and
resolved dependency locks are inputs. `local_only` keeps an action off remote
workers; it neither grants network access nor guarantees hermetic execution.

## Research

- Buck2 configuration: https://buck2.build/docs/users/getting_started/
- Buck2 macros: https://buck2.build/docs/bxl/how_tos/how_to_use_macros/
- Action API: https://buck2.build/docs/api/build/AnalysisActions/
- Loading data: https://buck2.build/docs/users/build_defs/load_data/
- Reindeer: https://github.com/facebookincubator/reindeer/blob/main/docs/MANUAL.md
- uv hashes: https://docs.astral.sh/uv/pip/compatibility/#hash-checking-mode
- Bun lockfile: https://bun.com/docs/pm/lockfile
