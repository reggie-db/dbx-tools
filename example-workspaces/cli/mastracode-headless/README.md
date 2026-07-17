# @dbx-tools/cli-mastracode-headless

Example CLI package for running Mastra Code interactively or headlessly.

## Overview

This package provides two bins:

- `mastracode` starts an interactive Mastra Code TUI.
- `mc-headless` runs a single prompt and prints the result for scripts or CI.

## Usage

Run from this package directory:

```sh
pnpm mastracode
pnpm mc-headless -- "summarize src/"
```

## Module

- `tui` - boots a local Mastra Code controller and starts the TUI.
- `headless` - creates a controller/session, runs one prompt, prints the text,
  and exits with the returned status code.

This package is an example of the `cli` tag with an external CLI-oriented
dependency. It is not part of the AppKit add-on surface.
