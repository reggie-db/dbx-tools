/**
 * A self-contained HTML login page the tunnel serves in front of an app that
 * does not embed the `<AuthGate>` React component (e.g. a WebSocket app fronted
 * by the CLI proxy).
 *
 * It speaks the same compatibility endpoints under {@link AUTH_PREFIX} that the
 * React client uses — `POST /request` to email a code, `POST /verify` to
 * exchange it for the `dbx-tools-auth` session cookie — with plain `fetch`, no
 * build step and no dependency. Passkeys are intentionally omitted: the WebAuthn
 * ceremony needs the better-auth client library, so passkey enrollment happens
 * inside the app after this email-OTP sign-in. On success the page reloads, and
 * the now-authenticated request reaches the app.
 *
 * @module
 */

import { AUTH_PREFIX } from "./gate.ts";

export interface LoginPageOptions {
  /** Product/brand name shown in the heading. */
  brandName: string;
}

/** The login page HTML for a `text/html` request to a gated path with no session. */
export function loginPageHtml(options: LoginPageOptions): string {
  const brand = escapeHtml(options.brandName);
  // AUTH_PREFIX is a fixed constant, not user input, but JSON-encode it so the
  // inlined script is always valid regardless of its value.
  const prefix = JSON.stringify(AUTH_PREFIX);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — ${brand}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1b1b1f; --muted: #6b7280; --border: #d9dce1;
    --accent: #1a73e8; --accent-fg: #ffffff; --error: #c5221f; --field: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d; --fg: #e8e6df; --muted: #9aa0aa; --border: #2c2f36;
      --accent: #4c8dff; --accent-fg: #0b0f19; --error: #ff6b60; --field: #1e2128;
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
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 14px; font-size: 13px; min-height: 18px; }
  .msg.error { color: var(--error); }
  .hidden { display: none; }
  .back { background: none; color: var(--muted); font-weight: 400; margin-top: 8px; }
</style>
</head>
<body>
  <main class="card">
    <h1>Sign in to ${brand}</h1>
    <p class="sub">Enter your email to receive a one-time code.</p>

    <form id="email-form">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required autofocus>
      <button id="email-submit" type="submit">Send code</button>
    </form>

    <form id="code-form" class="hidden">
      <label for="code">Verification code</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button id="code-submit" type="submit">Verify</button>
      <button id="back" type="button" class="back">Use a different email</button>
    </form>

    <div id="msg" class="msg" role="status" aria-live="polite"></div>
  </main>

<script>
(function () {
  var PREFIX = ${prefix};
  var emailForm = document.getElementById("email-form");
  var codeForm = document.getElementById("code-form");
  var emailInput = document.getElementById("email");
  var codeInput = document.getElementById("code");
  var back = document.getElementById("back");
  var msg = document.getElementById("msg");
  var email = "";

  function say(text, isError) {
    msg.textContent = text || "";
    msg.className = "msg" + (isError ? " error" : "");
  }

  async function post(path, body) {
    var res = await fetch(PREFIX + path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = {};
    try { data = await res.json(); } catch (_e) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data: data };
  }

  function errorText(data, fallback) {
    // better-auth error shape: { message } or { error: { message } }.
    if (data && data.error && data.error.message) return data.error.message;
    if (data && data.message) return data.message;
    return fallback;
  }

  emailForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    email = emailInput.value.trim();
    if (!email) return;
    var submit = document.getElementById("email-submit");
    submit.disabled = true;
    say("Sending…");
    try {
      // better-auth emailOTP native endpoint.
      var r = await post("/email-otp/send-verification-otp", { email: email, type: "sign-in" });
      if (r.ok) {
        emailForm.classList.add("hidden");
        codeForm.classList.remove("hidden");
        codeInput.focus();
        say("We emailed a code to " + email + ".");
      } else {
        say(errorText(r.data, "Could not send a code. Check the address and try again."), true);
      }
    } catch (_e) {
      say("Network error. Try again.", true);
    } finally {
      submit.disabled = false;
    }
  });

  codeForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var code = codeInput.value.trim();
    if (!code) return;
    var submit = document.getElementById("code-submit");
    submit.disabled = true;
    say("Verifying…");
    try {
      // better-auth sign-in with the OTP; sets the session cookie on success.
      var r = await post("/sign-in/email-otp", {
        email: email,
        otp: code,
        name: email.split("@")[0],
      });
      if (r.ok) {
        say("Signed in. Loading…");
        // The session cookie is set; reload so the now-authenticated request
        // reaches the app.
        window.location.reload();
      } else {
        say(errorText(r.data, "That code was not accepted. Try again."), true);
        submit.disabled = false;
      }
    } catch (_e) {
      say("Network error. Try again.", true);
      submit.disabled = false;
    }
  });

  back.addEventListener("click", function () {
    codeForm.classList.add("hidden");
    emailForm.classList.remove("hidden");
    codeInput.value = "";
    say("");
    emailInput.focus();
  });
})();
</script>
</body>
</html>`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
