import { string } from "@dbx-tools/shared-core";
import type { AuthStatus } from "@dbx-tools/shared-email";
import { Button, Input } from "@dbx-tools/ui-appkit/react";
import { BrandIcon, useBrand } from "@dbx-tools/ui-branding/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";

/**
 * Email one-time-code sign-in gate for an app fronted by the `@dbx-tools/email`
 * auth plugin - an app reachable on the public internet, where the hosting
 * platform's own identity-aware proxy is not in the request path.
 *
 * Wrap the app in `<AuthGate>...</AuthGate>`. It calls the plugin's
 * `/api/email/auth/*` routes: on mount it checks `status`; if the gate is
 * disabled or the caller already has a session it renders `children`
 * immediately, otherwise it shows the email -> code flow and reveals `children`
 * only after a verified code sets the session cookie.
 *
 * Presentational + fetch only: the session lives in an HttpOnly cookie the
 * browser sends automatically, so this component holds no token. Anti-enumeration
 * is server-side (every request-code call reports success), so the UI always
 * advances to the code step after the code is requested.
 *
 * Branding comes from the repo-wide `@dbx-tools/ui-branding` context, so the
 * sign-in screen carries the host app's mark and name - the same brand the gate's
 * code email is themed with - instead of a generic icon and a hardcoded product
 * name. With no `BrandProvider` above it, the dbx-tools default context applies.
 */

/** Base path the email auth routes are mounted under. */
const AUTH_BASE = "/api/email/auth";

type Phase = "loading" | "email" | "code" | "authed" | "open";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  return (await res.json()) as T;
}

/** Props for {@link AuthGate}. */
export interface AuthGateProps {
  /** The app to reveal once the caller is authenticated (or the gate is off). */
  children: ReactNode;
  /** Optional heading shown above the login form. */
  title?: string;
  /** Optional sub-text shown under the heading. */
  description?: string;
}

/**
 * Gate `children` behind the email-OTP login flow. Renders nothing meaningful
 * until the initial `status` check resolves; then either the app (authed / gate
 * off) or the two-step login.
 */
export function AuthGate({ children, title, description }: AuthGateProps): ReactNode {
  const { context: brand } = useBrand();
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // On mount, ask whether the gate is even on and whether we're already in.
  useEffect(() => {
    let cancelled = false;
    void fetch(`${AUTH_BASE}/status`, { credentials: "same-origin" })
      .then((res) => res.json() as Promise<AuthStatus>)
      .then((status) => {
        if (cancelled) return;
        if (!status.enabled) setPhase("open");
        else setPhase(status.authenticated ? "authed" : "email");
      })
      .catch(() => {
        // A failed status check shouldn't hard-lock the UI; show the login form.
        if (!cancelled) setPhase("email");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestCode = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!email.trim() || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await postJson<{ ok: true; retryAfter?: number }>(`${AUTH_BASE}/request`, {
          email: email.trim(),
        });
        // Anti-enumeration: always advance to the code step. Surface only a
        // rate-limit cooldown, which leaks no allow-list state.
        setNotice(
          result.retryAfter
            ? `Too many requests. Try again in ${string.pluralize(result.retryAfter, "second")}.`
            : "If an account exists for that email address, a verification code is on its way.",
        );
        setPhase("code");
      } finally {
        setBusy(false);
      }
    },
    [email, busy],
  );

  const verifyCode = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!code.trim() || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await postJson<{ ok: boolean; retryAfter?: number }>(`${AUTH_BASE}/verify`, {
          email: email.trim(),
          code: code.trim(),
        });
        if (result.ok) {
          setPhase("authed");
        } else {
          setNotice(
            result.retryAfter
              ? `Too many attempts. Try again in ${string.pluralize(result.retryAfter, "second")}.`
              : "That verification code is incorrect or has expired.",
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [code, email, busy],
  );

  if (phase === "authed" || phase === "open") return <>{children}</>;
  if (phase === "loading") return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-foreground">
          <BrandIcon className="size-5" alt="" aria-hidden />
          {/*
            Names the app, which is the convention for a sign-in screen and the
            reassurance a recipient checks the code against. `brand.name` is the
            same value that names the app in the code email.
          */}
          <h1 className="text-lg font-semibold">{title ?? `Sign in to ${brand.name}`}</h1>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {description ??
            (phase === "code"
              ? "Enter the 6-digit verification code sent to your email address."
              : "Enter your email address and we will send you a verification code.")}
        </p>

        {phase === "email" ? (
          <form key="email" onSubmit={requestCode} className="space-y-3">
            <Input
              type="email"
              name="email"
              autoComplete="email"
              aria-label="Email address"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending…" : "Send verification code"}
            </Button>
          </form>
        ) : (
          <form key="code" onSubmit={verifyCode} className="space-y-3">
            {/*
              `autoComplete="one-time-code"` is what lets iOS/Android/Safari offer
              the code straight from the notification, and it only pays off when
              the email keeps the conventional "Your verification code is: /
              <code>" shape the gate sends. `inputMode="numeric"` raises the
              number pad without rejecting a paste.
            */}
            <Input
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Verification code"
              placeholder="6-digit verification code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Verifying…" : "Continue"}
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground underline"
              onClick={() => {
                setPhase("email");
                setCode("");
                setNotice(null);
              }}
            >
              Use a different email address
            </button>
          </form>
        )}

        {notice ? (
          <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
