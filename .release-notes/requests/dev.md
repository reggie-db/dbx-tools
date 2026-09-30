# Release request: dev

Running `bun run release` is the release signal. It opens the source pull request with the caller's trusted GitHub identity, waits for checks, merges through a focused workflow, and dispatches Release Please publication without UI approval. No-op changes create no release work.
