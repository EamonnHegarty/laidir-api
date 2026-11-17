import type { APIGatewayProxyEventV2 } from "aws-lambda";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface JwtContext {
  authorizer?: { jwt?: { claims?: Record<string, unknown> } };
}

/**
 * The caller's Cognito `sub`, from the claims API Gateway's JWT authorizer already verified
 * (signature, issuer, expiry, and `client_id` in the audience list).
 *
 * Checked again here as defence in depth: it must be an access token from an allowed client with
 * a UUID `sub`. Returns undefined otherwise. **Every** data access is keyed on this value; no
 * endpoint takes a user ID from the path or body.
 */
export function callerSub(
  event: APIGatewayProxyEventV2,
  allowedClientIds: readonly string[],
): string | undefined {
  const claims = (event.requestContext as JwtContext).authorizer?.jwt?.claims;
  if (!claims) return undefined;
  if (claims.token_use !== "access") return undefined;
  const clientId = claims.client_id;
  if (typeof clientId !== "string" || !allowedClientIds.includes(clientId)) return undefined;
  const sub = claims.sub;
  if (typeof sub !== "string" || !UUID.test(sub)) return undefined;
  return sub;
}

/**
 * The caller's Cognito username (the access token's `username` claim; with email sign-in it's a
 * UUID). Falls back to the sub, which Cognito's admin APIs also accept. Only call this after
 * callerSub() succeeded.
 */
export function callerUsername(event: APIGatewayProxyEventV2, sub: string): string {
  const username = (event.requestContext as JwtContext).authorizer?.jwt?.claims?.username;
  return typeof username === "string" && username.length > 0 ? username : sub;
}

/** App client IDs whose access tokens /v1 accepts (set by Terraform). */
export function allowedClientIdsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.MOBILE_CLIENT_ID, env.DEVTOOLS_CLIENT_ID].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}
