/**
 * RFC 8414 authorization server metadata for the Claude connector, served at
 * `<api origin>/.well-known/oauth-authorization-server`.
 *
 * It's Cognito's discovery document with exactly three changes, because Claude's client is picky
 * about this document's shape (an earlier version advertising only the `none` auth method made
 * Claude stop before sign-in, as in anthropics/claude-ai-mcp#1125):
 * - `issuer`: our origin (RFC 8414 requires it to match where the document is served).
 * - `token_endpoint_auth_methods_supported`: `client_secret_post` only. Cognito lists Basic too,
 *   and Basic with the Claude client's empty secret fails with `invalid_client`; an empty
 *   `client_secret` in the body is accepted for this public client.
 * - `authorization_endpoint`: our redirect, for the quirk below.
 *
 * Cognito quirk: an authorize request with an RFC 8707 `resource` parameter (which Claude
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

/** Our metadata: Cognito's discovery document with the three changes described above. */
export function authServerMetadata(origin: string, cognito: Record<string, unknown>) {
  endpoint(cognito, "authorization_endpoint");
  endpoint(cognito, "token_endpoint");
  return {
    ...cognito,
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  };
}
