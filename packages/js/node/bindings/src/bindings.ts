import { executeHttp } from "./http.ts";
import { runProcess } from "./process.ts";
import type { JsBindings } from "./types.ts";

/** Default Node/Bun host bindings. */
export const nodeBindings: JsBindings = Object.freeze({ runProcess, executeHttp });
