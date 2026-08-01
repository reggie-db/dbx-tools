import { Button, Input } from "@dbx-tools/ui-appkit/react";
import type { AuthStatus } from "@dbx-tools/shared-email";
import { MailIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";

/**
 * Email-OTP login gate for an AppKit app fronted by the `@dbx-tools/email` auth
 * plugin (an app exposed publicly, e.g. through a portr tunnel that bypasses the
 * Databricks OAuth proxy).
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
 * advances to the code step after "send code".
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
            ? `Please wait ${result.retryAfter}s before requesting another code.`
            : "If that address is allowed, a code is on its way.",
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
              ? `Too many attempts. Wait ${result.retryAfter}s and request a new code.`
              : "That code didn't match. Check it or request a new one.",
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
          <MailIcon className="size-5" aria-hidden />
          <h1 className="text-lg font-semibold">{title ?? "Sign in"}</h1>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {description ?? "Enter your email to receive a one-time sign-in code."}
        </p>

        {phase === "email" ? (
          <form onSubmit={requestCode} className="space-y-3">
            <Input
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Sending…" : "Send code"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="space-y-3">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Verifying…" : "Verify"}
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
              Use a different email
            </button>
          </form>
        )}

        {notice ? <p className="mt-3 text-xs text-muted-foreground">{notice}</p> : null}
      </div>
    </div>
  );
}
