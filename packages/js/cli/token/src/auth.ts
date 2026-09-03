/**
 * Password and signed client-token authorization for broker requests.
 *
 * @module
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, SignJWT, jwtVerify } from "jose";

import { TOKEN_PROVIDERS, type BrokerAuthMode, type TokenProviderName } from "./config.ts";

const JWT_ISSUER = "dbx-tools-token-broker";
const JWT_AUDIENCE = "dbx-tools-token-broker";
const TOKEN_PROVIDER_SET = new Set<string>(TOKEN_PROVIDERS);

export interface ClientGrant {
  /** Stable client identity from the password session or JWT subject. */
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
  /** Configured client authentication mode. */
  mode: BrokerAuthMode;
  /** HTTP Authorization header. */
  authorization?: string;
  /** Expected password or HMAC verification secret. */
  secret?: string;
}

/** Mint a scope- and provider-constrained HS256 client JWT. */
export async function createClientToken(options: ClientTokenOptions): Promise<string> {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  return new SignJWT({
    providers: options.providers,
    scopes: options.scopes,
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT",
      kid: keyId(options.secret),
      name: options.client,
    })
    .setSubject(options.client)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + options.ttlSeconds)
    .sign(secretKey(options.secret));
}

/**
 * Infer the authorization header scheme for one client credential.
 *
 * A structurally valid compact JWT uses bearer authentication. Every other
 * value is treated as the shared password, including values containing dots.
 */
export function clientCredentialMode(credential: string): BrokerAuthMode {
  try {
    decodeProtectedHeader(credential);
    decodeJwt(credential);
    return "jwt";
  } catch {
    return "password";
  }
}

/**
 * Authenticate one request and return its effective client grant.
 *
 * Password clients remain constrained by server scope policy.
 */
export async function authorizeClient(options: AuthorizeOptions): Promise<ClientGrant> {
  if (options.mode === "password") {
    if (!options.secret || !basicPassword(options.authorization, options.secret)) {
      throw new AuthorizationError("Invalid broker password");
    }
    return {
      client: "password",
      providers: [...TOKEN_PROVIDERS],
    };
  }
  if (!options.secret) throw new AuthorizationError("JWT signing secret is unavailable");
  const token = bearerToken(options.authorization);
  if (!token) throw new AuthorizationError("Missing client bearer token");
  try {
    const verified = await jwtVerify(token, secretKey(options.secret), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });
    const subject = verified.payload.sub;
    if (!subject) throw new AuthorizationError("Client token has no subject");
    if (verified.protectedHeader.name !== undefined && verified.protectedHeader.name !== subject) {
      throw new AuthorizationError("Client token header name does not match its subject");
    }
    const providers = stringArray(verified.payload.providers).filter(
      (provider): provider is TokenProviderName => TOKEN_PROVIDER_SET.has(provider),
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
