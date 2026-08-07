import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

export const AUTH_BASE = "/api/email/auth";

const client = createAuthClient({
  baseURL:
    typeof window === "undefined"
      ? `http://localhost${AUTH_BASE}`
      : `${window.location.origin}${AUTH_BASE}`,
  plugins: [emailOTPClient(), passkeyClient()],
});

export interface PasskeySummary {
  id: string;
  name?: string | null;
  createdAt?: Date | string | null;
  deviceType?: string | null;
}

export async function requestEmailOtp(email: string): Promise<boolean> {
  const result = await client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  return result.error === null;
}

export async function verifyEmailOtp(
  email: string,
  otp: string,
  name: string,
): Promise<boolean> {
  const result = await client.signIn.emailOtp({ email, otp, name });
  return result.error === null;
}

export async function signInPasskey(): Promise<boolean> {
  const result = await client.signIn.passkey();
  return result.error === null;
}

export async function addPasskey(name?: string): Promise<boolean> {
  const result = await client.passkey.addPasskey(name ? { name } : undefined);
  return result.error === null;
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const result = await client.passkey.listUserPasskeys();
  return result.data ?? [];
}

export async function renamePasskey(id: string, name: string): Promise<boolean> {
  const result = await client.passkey.updatePasskey({ id, name });
  return result.error === null;
}

export async function removePasskey(id: string): Promise<boolean> {
  const result = await client.passkey.deletePasskey({ id });
  return result.error === null;
}
