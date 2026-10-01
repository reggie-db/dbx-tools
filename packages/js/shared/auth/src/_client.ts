/**
 * Browser-only Better Auth client shared by React and the hosted tunnel login.
 *
 * The operation helpers own both network cancellation and the active WebAuthn
 * ceremony. Each operation carries an identity token so cleanup from an older
 * React effect cannot cancel a newer manual attempt.
 *
 * @module
 */

import { passkeyClient, type Passkey } from "@better-auth/passkey/client";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";

import { AUTH_BASE_PATH } from "./_route.ts";
import type { AuthStatus } from "./auth.ts";

/** @deprecated Import `AUTH_BASE_PATH` from `@dbx-tools/shared-auth`. */
export const AUTH_BASE = AUTH_BASE_PATH;

/** Compatibility name for Better Auth's owned passkey record. */
export type PasskeySummary = Passkey;

interface BrowserLocation {
  readonly origin: string;
  assign(url: string): void;
}

function browserLocation(): BrowserLocation | undefined {
  return (globalThis as unknown as { location?: BrowserLocation }).location;
}

function baseURL(): string {
  const origin = browserLocation()?.origin ?? "http://localhost";
  return `${origin}${AUTH_BASE_PATH}`;
}

function browserClient(signal?: AbortSignal) {
  return createAuthClient({
    baseURL: baseURL(),
    ...(signal ? { fetchOptions: { signal } } : {}),
    plugins: [emailOTPClient(), passkeyClient()],
  });
}

const client = browserClient();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function authStatus(value: unknown): AuthStatus {
  const item = record(value);
  if (
    !item ||
    typeof item.authenticated !== "boolean" ||
    typeof item.enabled !== "boolean" ||
    (item.email !== undefined && typeof item.email !== "string") ||
    (item.passkeysEnabled !== undefined && typeof item.passkeysEnabled !== "boolean")
  ) {
    throw new Error("Auth status returned an invalid response");
  }
  return {
    authenticated: item.authenticated,
    enabled: item.enabled,
    ...(typeof item.email === "string" ? { email: item.email } : {}),
    ...(typeof item.passkeysEnabled === "boolean" ? { passkeysEnabled: item.passkeysEnabled } : {}),
  };
}

/** A cancellable passkey request and WebAuthn ceremony. */
export interface PasskeyOperation {
  readonly result: Promise<boolean>;
  cancel(): void;
}

interface ActivePasskeyOperation {
  readonly id: symbol;
  cancel(): void;
}

let activePasskeyOperation: ActivePasskeyOperation | undefined;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function beginPasskeyOperation(
  invoke: (operationClient: ReturnType<typeof browserClient>) => Promise<{ error: unknown }>,
): PasskeyOperation {
  activePasskeyOperation?.cancel();

  const id = Symbol("passkey-operation");
  const controller = new AbortController();
  let cancelled = false;
  const cancel = (): void => {
    if (activePasskeyOperation?.id !== id) return;
    activePasskeyOperation = undefined;
    cancelled = true;
    controller.abort();
    WebAuthnAbortService.cancelCeremony();
  };
  activePasskeyOperation = { id, cancel };

  const result = invoke(browserClient(controller.signal))
    .then((response) => !cancelled && response.error === null)
    .catch((error: unknown) => {
      if (cancelled || isAbort(error)) return false;
      throw error;
    })
    .finally(() => {
      if (activePasskeyOperation?.id === id) activePasskeyOperation = undefined;
    });

  return { result, cancel };
}

/** Start a passkey sign-in whose lifetime is explicitly owned by the caller. */
export function beginPasskeySignIn(autoFill = false): PasskeyOperation {
  return beginPasskeyOperation((operationClient) => operationClient.signIn.passkey({ autoFill }));
}

/** Start a passkey registration whose lifetime is explicitly owned by the caller. */
export function beginPasskeyEnrollment(name?: string): PasskeyOperation {
  return beginPasskeyOperation((operationClient) =>
    operationClient.passkey.addPasskey(name ? { name } : undefined),
  );
}

/** Cancel the currently active passkey request and browser ceremony, if any. */
export function cancelPasskeyOperation(): void {
  activePasskeyOperation?.cancel();
}

/** Read the current browser session status from the shared auth endpoint. */
export async function getAuthStatus(): Promise<AuthStatus> {
  const response = await fetch(`${AUTH_BASE_PATH}/status`, { credentials: "include" });
  if (!response.ok) throw new Error(`Auth status failed with ${response.status}`);
  return authStatus(await response.json());
}

/** End the current browser session and follow the server's same-origin redirect. */
export async function logout(): Promise<boolean> {
  const response = await fetch(`${AUTH_BASE_PATH}/logout`, {
    method: "POST",
    credentials: "include",
  });
  const result = record(await response.json());
  if (!response.ok || result?.ok !== true || typeof result.redirectTo !== "string") return false;
  browserLocation()?.assign(result.redirectTo);
  return true;
}

/** Request an email one-time password for the supplied address. */
export async function requestEmailOtp(email: string): Promise<boolean> {
  const result = await client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  return result.error === null;
}

/** Verify an email one-time password and establish a browser session. */
export async function verifyEmailOtp(email: string, otp: string, name: string): Promise<boolean> {
  const result = await client.signIn.emailOtp({ email, otp, name });
  return result.error === null;
}

/** Authenticate with a passkey, optionally using conditional browser mediation. */
export async function signInPasskey(autoFill = false): Promise<boolean> {
  return beginPasskeySignIn(autoFill).result;
}

/** Enroll a passkey for the current authenticated account. */
export async function addPasskey(name?: string): Promise<boolean> {
  return beginPasskeyEnrollment(name).result;
}

/** List passkeys enrolled for the current authenticated account. */
export async function listPasskeys(): Promise<PasskeySummary[]> {
  const result = await client.passkey.listUserPasskeys();
  if (result.error) {
    throw new Error(result.error.message ?? `Passkey listing failed with ${result.error.status}`);
  }
  return result.data ?? [];
}

/** Rename an enrolled passkey. */
export async function renamePasskey(id: string, name: string): Promise<boolean> {
  const result = await client.passkey.updatePasskey({ id, name });
  return result.error === null;
}

/** Remove an enrolled passkey. */
export async function removePasskey(id: string): Promise<boolean> {
  const result = await client.passkey.deletePasskey({ id });
  return result.error === null;
}
