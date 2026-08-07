import { net } from "@dbx-tools/shared-core";
import type { AuthStatus } from "@dbx-tools/shared-auth";
import { Button, Input } from "@dbx-tools/ui-appkit/react";
import { BrandIcon, useBrand } from "@dbx-tools/ui-branding/react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";

import {
  addPasskey,
  AUTH_BASE,
  requestEmailOtp,
  signInPasskey,
  verifyEmailOtp,
} from "./auth-client.ts";

type Phase = "loading" | "email" | "code" | "enroll" | "authed" | "open";

export interface AuthGateProps {
  children: ReactNode;
  title?: string;
  description?: string;
}

/** Passkey-first gate with email OTP bootstrap and recovery. */
export function AuthGate({ children, title, description }: AuthGateProps): ReactNode {
  const { context: brand } = useBrand();
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [passkeysEnabled, setPasskeysEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${AUTH_BASE}/status`, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Authentication status failed (${response.status})`);
        return (await response.json()) as AuthStatus;
      })
      .then((status) => {
        if (cancelled) return;
        setPasskeysEnabled(status.passkeysEnabled === true);
        setPhase(status.enabled ? (status.authenticated ? "authed" : "email") : "open");
      })
      .catch(() => {
        if (!cancelled) setPhase("email");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestCode = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy) return;
      const addresses = net.parseEmails(email);
      const address = addresses[0];
      if (addresses.length !== 1 || !address || !net.isEmail(address)) {
        setNotice("Enter a valid email address.");
        return;
      }
      setBusy(true);
      setNotice(null);
      setEmail(address);
      try {
        if (!(await requestEmailOtp(address))) throw new Error("OTP request failed");
        setNotice("If the address is authorized, a verification code is on its way.");
        setPhase("code");
      } catch {
        setNotice("Unable to request a verification code. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [busy, email],
  );

  const verifyCode = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!code.trim() || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        if (!(await verifyEmailOtp(email, code.trim(), email.split("@")[0] || "User"))) {
          throw new Error("OTP verification failed");
        }
        setPhase(passkeysEnabled ? "enroll" : "authed");
      } catch {
        setNotice("That verification code is incorrect or has expired.");
      } finally {
        setBusy(false);
      }
    },
    [busy, code, email, passkeysEnabled],
  );

  const usePasskey = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (!(await signInPasskey())) throw new Error("Passkey authentication failed");
      setPhase("authed");
    } catch {
      setNotice("Unable to sign in with a passkey. Use email recovery instead.");
    } finally {
      setBusy(false);
    }
  }, []);

  const enroll = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (!(await addPasskey("Primary passkey"))) throw new Error("Passkey enrollment failed");
      setPhase("authed");
    } catch {
      setNotice("Unable to create a passkey. You can continue with email recovery.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (phase === "authed" || phase === "open") return <>{children}</>;
  if (phase === "loading") return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-foreground">
          <BrandIcon className="size-5" alt="" aria-hidden />
          <h1 className="text-lg font-semibold">{title ?? `Sign in to ${brand.name}`}</h1>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {description ??
            (phase === "code"
              ? "Enter the 6-digit verification code sent to your email address."
              : phase === "enroll"
                ? "Create a passkey for faster, phishing-resistant sign-in next time."
                : "Use a passkey or enter your email address for a verification code.")}
        </p>

        {phase === "email" ? (
          <form noValidate onSubmit={requestCode} className="space-y-3">
            <Input
              type="email"
              autoComplete="email webauthn"
              aria-label="Email address"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            {passkeysEnabled ? (
              <Button type="button" disabled={busy} className="w-full" onClick={usePasskey}>
                Sign in with a passkey
              </Button>
            ) : null}
            <Button type="submit" variant="outline" disabled={busy} className="w-full">
              Send verification code
            </Button>
          </form>
        ) : phase === "code" ? (
          <form onSubmit={verifyCode} className="space-y-3">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Verification code"
              placeholder="6-digit verification code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
            <Button type="submit" disabled={busy} className="w-full">
              Continue
            </Button>
          </form>
        ) : (
          <div className="space-y-3">
            <Button type="button" disabled={busy} className="w-full" onClick={enroll}>
              Create a passkey
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => setPhase("authed")}>
              Not now
            </Button>
          </div>
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
