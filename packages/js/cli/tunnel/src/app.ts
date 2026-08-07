/**
 * The GATE half of the wrapper: a server-less AppKit app whose only job is to
 * expose the `authGate` handlers the proxy calls.
 *
 * The in-process plugin path (`authGate` in the app's own `plugins`) has a real
 * HTTP server to mount routes on. A wrapper does not - the app it fronts is a
 * separate process it must not reach into - so the gate's login routes live on
 * the proxy instead, and this app exists purely to give the plugin the runtime it
 * needs: a `CacheManager` for the one-time-code store and signing key, and the
 * sibling `email` plugin's transport for delivering a code.
 *
 * Lazily imported by `cli.ts`, so `dbx tunnel --insecure` (and `install` /
 * `status`) never load AppKit, the Databricks SDK, or the SMTP stack.
 *
 * @module
 */

import { appkit } from "@dbx-tools/appkit";
import { storage as authStorage } from "@dbx-tools/auth";
import { lakebase } from "@databricks/appkit";
import { email } from "@dbx-tools/email";
import { object } from "@dbx-tools/shared-core";
import { authGate, type AuthGateApi, type AuthGateConfig } from "@dbx-tools/tunnel";

/** Boot the gate app and return the handlers the proxy authenticates against. */
export async function startGateApp(config: AuthGateConfig): Promise<AuthGateApi> {
  // No `server()` plugin: nothing here listens. `plugins` order matters - `email`
  // registers its transport before `authGate` looks for a sibling to send with.
  const plugins = await appkit.createApp({
    plugins: [
      ...(authStorage.shouldUseLakebase(config) ? [lakebase()] : []),
      email(),
      authGate(config),
    ],
  });
  const api = Reflect.get(plugins, "authGate");
  if (!isAuthGateApi(api)) throw new Error("the authGate plugin exposed no api");
  return api;
}

function isAuthGateApi(value: unknown): value is AuthGateApi {
  return (
    object.isRecord(value) &&
    typeof value.handler === "function" &&
    typeof value.session === "function" &&
    typeof value.status === "function"
  );
}
