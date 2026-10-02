import { createClient, FetchTransport } from "@rspc/client";
import { createReactQueryHooks } from "@rspc/react-query";
import { TauriTransport } from "@rspc/tauri";

import type { Procedures } from "./bindings.ts";

const transport =
  "__TAURI_INTERNALS__" in window
    ? new TauriTransport()
    : new FetchTransport(`${window.location.origin}/rspc`);

export const rspc = createReactQueryHooks<Procedures>();

export const client = createClient<Procedures>({ transport });
