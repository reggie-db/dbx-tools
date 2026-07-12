/**
 * The auto-scaffold record.
 *
 * `configureProjen` discovers `packages/<scope>/<name>/src` folders at synth
 * time and, for any that a hand-authored spec doesn't cover, both configures
 * them and writes them here as a projen-owned (read-only, marker) `JsonFile`.
 * Nothing reads this file back - it exists so it's visible which packages were
 * scaffolded from their `src/` folder rather than declared in `.projenrc.ts`.
 */
export const DISCOVERED_FILE = "projenrc/discovered.json";
