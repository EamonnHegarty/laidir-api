import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** A minimal API Gateway HTTP API (payload v2) event for handler tests. */
export function httpEvent(method: string, path: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      accountId: "123456789012",
      apiId: "test",
      domainName: "test.execute-api.eu-west-1.amazonaws.com",
      domainPrefix: "test",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.1", userAgent: "vitest" },
      requestId: "req-1",
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "15/Nov/2026:09:00:00 +0000",
      timeEpoch: 1794733200000,
    },
  };
}

export const MOBILE_CLIENT = "mobileclient123";
export const SUB_A = "11111111-1111-4111-8111-111111111111";
export const SUB_B = "22222222-2222-4222-8222-222222222222";

export interface V1EventOptions {
  sub?: string;
  claims?: Record<string, unknown> | null;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  base64?: boolean;
}

/**
 * An event as API Gateway delivers it on `ANY /v1/{proxy+}` after the JWT authorizer passed.
 * `claims: null` leaves the authorizer context out.
 */
export function v1Event(method: string, path: string, opts: V1EventOptions = {}) {
  const event = httpEvent(method, path);
  event.routeKey = "ANY /v1/{proxy+}";
  event.requestContext.routeKey = "ANY /v1/{proxy+}";
  if (opts.claims !== null) {
    const claims = opts.claims ?? {
      sub: opts.sub ?? SUB_A,
      token_use: "access",
      client_id: MOBILE_CLIENT,
      scope: "openid email profile",
    };
    Object.assign(event.requestContext, { authorizer: { jwt: { claims, scopes: null } } });
  }
  if (opts.query) event.queryStringParameters = opts.query;
  let body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && opts.base64) {
    body = Buffer.from(body, "utf8").toString("base64");
    event.isBase64Encoded = true;
  }
  if (body !== undefined) event.body = body;
  return event;
}
