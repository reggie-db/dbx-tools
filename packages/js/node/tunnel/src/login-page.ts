/**
 * Self-contained login document for applications that do not embed the React
 * AuthGate. The packaged browser client uses the same Better Auth operations as
 * the React surface for conditional and manual passkeys plus email OTP.
 *
 * @module
 */

import { AUTH_BASE_PATH } from "@dbx-tools/shared-auth";
import { stringUtils } from "@dbx-tools/shared-core";
import { LOGIN_CLIENT_SOURCE } from "./generated/_login-client.ts";

export interface LoginPageOptions {
  /** Product/brand name shown in the heading. */
  brandName: string;
  /** Validated same-origin path loaded after authentication succeeds. */
  returnTo: string;
}

/** The login page HTML for a `text/html` request to a gated path with no session. */
export function loginPageHtml(options: LoginPageOptions): string {
  const brand = stringUtils.escapeHtml(options.brandName);
  const returnTo = stringUtils.escapeHtml(options.returnTo);
  // prettier-ignore
  return stringUtils.dedent(
    // ============================================================================
    /*html*/`
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in — ${brand}</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #ffffff; --fg: #1b1b1f; --muted: #6b7280; --border: #d9dce1;
        --accent: #FF3621; --accent-fg: #ffffff; --error: #c5221f; --field: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #16181d; --fg: #e8e6df; --muted: #9aa0aa; --border: #2c2f36;
          --accent: #FF5A46; --accent-fg: #0b0f19; --error: #ff6b60; --field: #1e2128;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center;
        justify-content: center; background: var(--bg); color: var(--fg);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px;
      }
      .card {
        width: 100%; max-width: 360px; border: 1px solid var(--border);
        border-radius: 14px; padding: 28px; background: var(--bg);
      }
      .logo { width: 40px; height: 40px; display: block; margin: 0 0 14px; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      p.sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
      label { display: block; font-size: 12px; color: var(--muted); margin: 0 0 6px; }
      input {
        width: 100%; padding: 10px 12px; font-size: 15px; border-radius: 9px;
        border: 1px solid var(--border); background: var(--field); color: var(--fg);
      }
      input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
      button {
        width: 100%; margin-top: 16px; padding: 10px 12px; font-size: 15px;
        font-weight: 600; border: 0; border-radius: 9px; background: var(--accent);
        color: var(--accent-fg); cursor: pointer;
      }
      button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
      button:disabled { opacity: 0.6; cursor: default; }
      button[hidden] { display: none; }
      .msg { margin-top: 14px; font-size: 13px; min-height: 18px; }
      .msg.error { color: var(--error); }
      .hidden { display: none; }
      .back { background: none; color: var(--muted); font-weight: 400; margin-top: 8px; }
    </style>
    </head>
    <body data-return-to="${returnTo}" data-auth-base="${AUTH_BASE_PATH}">
      <main class="card">
        <svg class="logo" viewBox="0 0 64 64" role="img" aria-label="${brand}" shape-rendering="crispEdges">
          <rect x="19" y="20" width="8" height="8" rx="1" fill="#FF3621"/><rect x="37" y="20" width="8" height="8" rx="1" fill="#FF3621"/>
          <rect x="1" y="29" width="8" height="8" rx="1" fill="#D92D18"/><rect x="10" y="29" width="8" height="8" rx="1" fill="#FF3621"/><rect x="19" y="29" width="8" height="8" rx="1" fill="#FF5A46"/><rect x="28" y="29" width="8" height="8" rx="1" fill="#FF8974"/><rect x="37" y="29" width="8" height="8" rx="1" fill="#FF5A46"/><rect x="46" y="29" width="8" height="8" rx="1" fill="#FF3621"/><rect x="55" y="29" width="8" height="8" rx="1" fill="#D92D18"/>
          <rect x="10" y="38" width="8" height="8" rx="1" fill="#FF3621"/><rect x="46" y="38" width="8" height="8" rx="1" fill="#FF3621"/>
        </svg>
        <h1>Sign in to ${brand}</h1>
        <p class="sub">Use a passkey or receive a one-time code by email.</p>

        <form id="email-form">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email webauthn" required autofocus>
          <button id="email-submit" type="submit">Send code</button>
          <button id="passkey-submit" class="secondary" type="button" hidden>Sign in with a passkey</button>
        </form>

        <form id="code-form" class="hidden">
          <label for="code">Verification code</label>
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
          <button id="code-submit" type="submit">Verify</button>
          <button id="back" type="button" class="back">Use a different email</button>
        </form>

        <div id="msg" class="msg" role="status" aria-live="polite"></div>
      </main>
    <script>${LOGIN_CLIENT_SOURCE}</script>
    </body>
    </html>
    `
    // ============================================================================
  );
}
