/**
 * RFC 8414 authorization server metadata for the Claude connector, served at
 * `<api origin>/.well-known/oauth-authorization-server`.
 *
 * Why not point Claude straight at Cognito: Cognito's discovery document lists only
 * `client_secret_basic` and `client_secret_post` as token endpoint auth methods. The Claude client is
 * public (PKCE, no secret), and Claude picks an auth method from that list, so it sends Basic auth
 * with an empty secret, which Cognito rejects with `invalid_client`. This document is Cognito's,
 * with `issuer` set to our origin (RFC 8414 requires it to match where it's served) and the auth
 * method set to `none`, so Claude sends `client_id` in the body.
 *
 * Second Cognito quirk: an authorize request with an RFC 8707 `resource` parameter (which Claude
 * always sends) is accepted, but redeeming its code then fails with `invalid_grant` when no Cognito
 * resource server matches. So `authorization_endpoint` is our own redirect (AUTHORIZE_PATH), which
 * forwards every parameter except `resource` to Cognito. `resource` on the token request is
 * harmless (ignored). Tokens therefore have no `aud`; the MCP server binds them to itself by
 * client instead (only the Claude client, which exists solely for this connector).
 *
 * Token, revocation and keys stay Cognito's; access tokens keep Cognito's `iss`.
 */
export const AUTH_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** Our authorize redirect (see above). */
export const AUTHORIZE_PATH = "/oauth/authorize";

/**
 * Where to send the browser: Cognito's authorize endpoint with the same query, minus `resource`.
 * Only ever redirects to Cognito; Cognito validates client_id and redirect_uri.
 */
export function authorizeRedirect(cognito: Record<string, unknown>, rawQuery: string): string {
  const target = new URL(endpoint(cognito, "authorization_endpoint"));
  const params = new URLSearchParams(rawQuery);
  params.delete("resource");
  target.search = params.toString();
  return target.href;
}

/** What the Claude client may ask for (its allowed scopes in Cognito). */
const SCOPES = ["openid", "email", "profile"];

const CACHE_MS = 60 * 60 * 1000;
let cached: { at: number; doc: Record<string, unknown> } | undefined;

/** Cognito's OpenID discovery document, cached per Lambda instance for an hour. */
export async function cognitoDiscovery(
  issuer: string,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  if (cached && now - cached.at < CACHE_MS) return cached.doc;
  const res = await fetchFn(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Cognito discovery returned ${String(res.status)}`);
  const doc = (await res.json()) as Record<string, unknown>;
  cached = { at: now, doc };
  return doc;
}

/** Test hook: forget the cached discovery document. */
export function clearDiscoveryCache(): void {
  cached = undefined;
}

function endpoint(doc: Record<string, unknown>, name: string): string {
  const value = doc[name];
  if (typeof value !== "string" || !value.startsWith("https://")) {
    throw new Error(`Cognito discovery has no ${name}`);
  }
  return value;
}

/** Our metadata, built from Cognito's discovery document. */
export function authServerMetadata(origin: string, cognito: Record<string, unknown>) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: endpoint(cognito, "token_endpoint"),
    revocation_endpoint: endpoint(cognito, "revocation_endpoint"),
    jwks_uri: endpoint(cognito, "jwks_uri"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
  };
}
