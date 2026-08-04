# `dbx-tools-core`

Dependency-free Python helpers shared by dbx-tools packages.

The package intentionally contains only the cross-runtime identity primitives
currently needed by more than one implementation:

- `hash.fnv_hash()` — the single-string subset of TypeScript
  `fnvHashWithOptions`, including UTF-16 code-unit hashing and base-32 output;
- `object.to_stable_key()` — strict structured identity canonicalization;
- `string.to_identifier()` — readable identifier tokenization.

These functions exist so Python packages do not copy the TypeScript algorithms
locally and silently drift. Add broader helpers only when another Python package
actually needs them.
