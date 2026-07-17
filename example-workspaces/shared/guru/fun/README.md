# @dbx-tools/shared-guru-fun

Nested example shared package.

## Overview

This package exists to prove that workspace discovery handles packages below
multiple path segments, not only one-level folders under a workspace root.

## Modules

- `hello` - greeting helpers.
- `wow` - placeholder function used by the nested package example.

## Usage

```ts
import { hello } from "@dbx-tools/shared-guru-fun";

hello.hello("Ada");
```

It is a demonstration package, not a production AppKit add-on.
