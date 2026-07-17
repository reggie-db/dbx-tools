# @dbx-tools/example-shared-core

Small browser-safe shared package used by the example CLI, server, and UI
packages.

## Overview

This package demonstrates the `shared` tag: no Node globals, no DOM requirement,
and simple modules exported through the generated package barrel.

## Modules

- `math` - `add`, `subtract`, and `clamp`.
- `strings` - `capitalize` and `greet`.

## Usage

```ts
import { math, strings } from "@dbx-tools/example-shared-core";

math.add(1, 2);
strings.greet("Ada");
```

The package exists to exercise workspace dependency wiring and barrel generation.
