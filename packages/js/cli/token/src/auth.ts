/**
 * Password and signed client-token authorization for broker requests.
 *
 * @module
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import type { BrokerAuthMode, TokenProviderName } from "./config.ts";

const JWT_ISSUER = "dbx-tools-token-broker";
const JWT_AUDIENCE = "dbx-tools-token-broker";

export interface ClientGrant {
  /** Stable client identity from the password session, JWT subject, or mTLS CN. */
  client: string;
  /** Providers this client token permits. */
  providers: TokenProviderName[];
  /** Exact scope allow-list; omitted for password/no-auth clients. */
  scopes?: string[];
}

/** Inputs used to mint one HMAC-signed broker client credential. */
export interface ClientTokenOptions extends ClientGrant {
  /** HMAC signing secret, loaded from keychain unless explicitly configured. */
  secret: string;
  /** Token lifetime in seconds. */
  ttlSeconds: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Request credentials and transport identity presented to the authorizer. */
export interface AuthorizeOptions {
  /** Configured application auth mode. */
  mode: BrokerAuthMode;
  /** HTTP Authorization header. */
  authorization?: string;
  /** Expected password in password mode. */
  password?: string;
  /** HMAC verification secret in JWT mode. */
  signingSecret?: string;
  /** Peer certificate common name when mTLS is active. */
  certificateName?: string;
}

/** Mint a scope- and provider-constrained HS256 client JWT. */
export async function createClientToken(options: ClientTokenOptions): Promise<string> {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  return new SignJWT({
    providers: options.providers,
    scopes: options.scopes,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: keyId(options.secret) })
    .setSubject(options.client)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + options.ttlSeconds)
    .sign(secretKey(options.secret));
}

/**
 * Authenticate one request and return its effective client grant.
 *
 * JWT subjects must match the mTLS certificate common name when both layers are
 * active. Password and no-auth modes remain constrained by server scope policy.
 */
export async function authorizeClient(options: AuthorizeOptions): Promise<ClientGrant> {
  if (options.mode === "none") {
    return {
      client: options.certificateName ?? "local",
      providers: ["google"],
    };
  }
  if (options.mode === "password") {
    if (!options.password || !basicPassword(options.authorization, options.password)) {
      throw new AuthorizationError("Invalid broker password");
    }
    return {
      client: options.certificateName ?? "password",
      providers: ["google"],
    };
  }
  if (!options.signingSecret) throw new AuthorizationError("JWT signing secret is unavailable");
  const token = bearerToken(options.authorization);
  if (!token) throw new AuthorizationError("Missing client bearer token");
  try {
    const verified = await jwtVerify(token, secretKey(options.signingSecret), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });
    const subject = verified.payload.sub;
    if (!subject) throw new AuthorizationError("Client token has no subject");
    if (options.certificateName && options.certificateName !== subject) {
      throw new AuthorizationError("Client token does not match the mTLS certificate");
    }
    const providers = stringArray(verified.payload.providers).filter(
      (provider): provider is TokenProviderName => provider === "google",
    );
    const scopes = stringArray(verified.payload.scopes);
    if (providers.length === 0) throw new AuthorizationError("Client token allows no providers");
    return {
      client: subject,
      providers,
      scopes,
    };
  } catch (cause) {
    if (cause instanceof AuthorizationError) throw cause;
    throw new AuthorizationError("Invalid client bearer token");
  }
}

/** Authentication or grant failure that the HTTP layer maps to status 401. */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function basicPassword(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    return equalSecret(supplied, expected);
  } catch {
    return false;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function keyId(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url").slice(0, 16);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
