import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from "jose";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Scopes the Claude client asks Cognito for (the client's allowed scopes). */
export const SCOPES = ["openid", "email", "profile"] as const;

export interface VerifyConfig {
  /** Cognito issuer, e.g. https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc. */
  issuer: string;
  /** The Claude app client: tokens from any other client are rejected. */
  clientId: string;
  /** Signing keys (the issuer's JWKS). */
  keys: JWTVerifyGetKey;
}

export type Verified = { ok: true; sub: string; auth: AuthInfo } | { ok: false; reason: string };

/**
 * Verifies a Cognito access token for this MCP server (there's no gateway authorizer on /mcp):
 * signature (RS256, issuer's JWKS), issuer, expiry, `token_use=access`, the Claude client, a UUID
 * `sub`, and that it was issued for this server: Claude sends the RFC 8707 `resource` parameter
 * and Cognito puts it in `aud`, so `aud` must equal the MCP URL.
 *
 * `reason` is safe to log (it never contains the token).
 */
export async function verifyAccessToken(
  token: string,
  resource: string,
  cfg: VerifyConfig,
): Promise<Verified> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, cfg.keys, {
      issuer: cfg.issuer,
      algorithms: ["RS256"],
      clockTolerance: 5,
    }));
  } catch (err) {
    return { ok: false, reason: err instanceof errors.JOSEError ? err.code : "unverifiable" };
  }
  if (payload.token_use !== "access") return { ok: false, reason: "not an access token" };
  if (payload.client_id !== cfg.clientId) return { ok: false, reason: "wrong client" };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(resource)) return { ok: false, reason: "wrong audience" };
  const sub = payload.sub;
  if (typeof sub !== "string" || !UUID.test(sub)) return { ok: false, reason: "bad sub" };

  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
  const auth: AuthInfo = {
    token,
    clientId: cfg.clientId,
    scopes,
    resource: new URL(resource),
    extra: { sub },
  };
  if (payload.exp !== undefined) auth.expiresAt = payload.exp;
  return { ok: true, sub, auth };
}

/** The issuer's signing keys, fetched on first use and cached by jose for the Lambda's lifetime. */
export function cognitoKeys(issuer: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    timeoutDuration: 3000,
  });
}

/** The bearer token from an Authorization header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i.exec(header ?? "");
  return match?.[1];
}
