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
