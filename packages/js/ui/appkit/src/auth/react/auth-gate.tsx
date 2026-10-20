import { Button, Checkbox, Input, Label } from "@databricks/appkit-ui/react";
import {
  browser,
  type PasskeyOperation,
  getAuthStatus,
  passkeysAvailable,
  beginPasskeySignIn,
  requestEmailOtp,
  verifyEmailOtp,
  beginPasskeyEnrollment,
} from "@dbx-tools/shared-auth";
import { parseEmails, isEmail } from "@dbx-tools/shared-core";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { BrandIcon, useBrand } from "@dbx-tools/ui/branding/react";

type Phase = "loading" | "email" | "code" | "authed" | "open";

/** Protected content and optional sign-in copy rendered by {@link AuthGate}. */
export interface AuthGateProps {
  children: ReactNode;
  title?: string;
  description?: string;
  /** Prefix added before the humanized tunnel subdomain in new passkey names. */
  passkeyNamePrefix?: string;
}

/** Email OTP gate with conditional passkey sign-in and optional inline enrollment. */
export function AuthGate({
  children,
  title,
  description,
  passkeyNamePrefix,
}: AuthGateProps): ReactNode {
  const { context: brand } = useBrand();
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [passkeysEnabled, setPasskeysEnabled] = useState(false);
  const [configuredPasskeyNamePrefix, setConfiguredPasskeyNamePrefix] = useState<
    string | undefined
  >();
  const [createPasskey, setCreatePasskey] = useState(true);
  const passkeyOperation = useRef<PasskeyOperation | undefined>(undefined);

  const cancelPasskey = useCallback(() => {
    const operation = passkeyOperation.current;
    passkeyOperation.current = undefined;
    operation?.cancel();
  }, []);

  useEffect(() => cancelPasskey, [cancelPasskey]);

  useEffect(() => {
    let cancelled = false;
    void getAuthStatus()
      .then((status) => {
        if (cancelled) return;
        setPasskeysEnabled(status.passkeysEnabled === true && passkeysAvailable());
        setConfiguredPasskeyNamePrefix(status.passkeyNamePrefix);
        setPhase(status.enabled ? (status.authenticated ? "authed" : "email") : "open");
      })
      .catch(() => {
        if (!cancelled) setPhase("email");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!passkeysEnabled || phase !== "email") {
      cancelPasskey();
      return;
    }
    if (
      typeof PublicKeyCredential === "undefined" ||
      typeof PublicKeyCredential.isConditionalMediationAvailable !== "function"
    ) {
      return;
    }
    let cancelled = false;
    let ownedOperation: PasskeyOperation | undefined;
    // Conditional mediation cannot reveal whether a credential exists. It lets
    // the browser offer one immediately on the focused `webauthn` input without
    // showing an empty modal to users who have no passkey.
    void PublicKeyCredential.isConditionalMediationAvailable()
      .then(async (available) => {
        if (cancelled) return;
        if (!available) return;
        cancelPasskey();
        const operation = beginPasskeySignIn(true);
        ownedOperation = operation;
        passkeyOperation.current = operation;
        const authenticated = await operation.result;
        if (passkeyOperation.current === operation) {
          passkeyOperation.current = undefined;
          if (!cancelled && authenticated) setPhase("authed");
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ownedOperation?.cancel();
      if (passkeyOperation.current === ownedOperation) passkeyOperation.current = undefined;
    };
  }, [cancelPasskey, passkeysEnabled, phase]);

  const requestCode = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy) return;
      const addresses = parseEmails(email);
      const address = addresses[0];
      if (addresses.length !== 1 || !address || !isEmail(address)) {
        setNotice("Enter a valid email address.");
        return;
      }
      cancelPasskey();
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
    [busy, cancelPasskey, email],
  );

  const verifyCode = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!code.trim() || busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const verified = await verifyEmailOtp(
          email,
          code.trim(),
          email.split("@")[0] || "User",
        ).catch(() => false);
        if (!verified) {
          setNotice("That verification code is incorrect or has expired.");
          return;
        }
        if (passkeysEnabled && createPasskey) {
          let operation: PasskeyOperation | undefined;
          try {
            operation = beginPasskeyEnrollment(
              browser.passkeyDisplayName(passkeyNamePrefix ?? configuredPasskeyNamePrefix),
            );
            passkeyOperation.current = operation;
            await operation.result;
          } catch {
            // The verified OTP session remains valid when enrollment is unavailable or cancelled.
          } finally {
            if (operation && passkeyOperation.current === operation) {
              passkeyOperation.current = undefined;
            }
          }
        }
        setPhase("authed");
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      code,
      configuredPasskeyNamePrefix,
      createPasskey,
      email,
      passkeyNamePrefix,
      passkeysEnabled,
    ],
  );

  const usePasskey = useCallback(async () => {
    cancelPasskey();
    const operation = beginPasskeySignIn();
    passkeyOperation.current = operation;
    setBusy(true);
    setNotice(null);
    try {
      if (!(await operation.result)) throw new Error("Passkey authentication failed");
      if (passkeyOperation.current !== operation) return;
      passkeyOperation.current = undefined;
      setPhase("authed");
    } catch {
      if (passkeyOperation.current === operation) {
        setNotice("Unable to sign in with a passkey. Use email recovery instead.");
      }
    } finally {
      if (passkeyOperation.current === operation) {
        passkeyOperation.current = undefined;
        setBusy(false);
      }
    }
  }, [cancelPasskey]);

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
              : "Enter your email for a one-time code, or use a passkey.")}
        </p>

        {phase === "email" ? (
          <form noValidate onSubmit={requestCode} className="space-y-3">
            <Input
              type="email"
              autoComplete="email webauthn"
              autoFocus
              aria-label="Email address"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <Button type="submit" disabled={busy} className="w-full">
              Sign in with email OTP
            </Button>
            {passkeysEnabled ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                className="w-full"
                onClick={usePasskey}
              >
                Sign in with a passkey
              </Button>
            ) : null}
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
            {passkeysEnabled ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="create-passkey"
                  checked={createPasskey}
                  disabled={busy}
                  onCheckedChange={(checked) => setCreatePasskey(checked === true)}
                />
                <Label htmlFor="create-passkey" className="text-sm font-normal">
                  Create passkey
                </Label>
              </div>
            ) : null}
            <Button type="submit" disabled={busy} className="w-full">
              Continue
            </Button>
          </form>
        ) : null}

        {notice ? (
          <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
