import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

/** A JSON response. */
export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** RFC 9457 problem details. */
export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

/** An RFC 9457 `application/problem+json` error response. */
export function problem(
  status: number,
  title: string,
  extra: Omit<Problem, "status" | "title"> = {},
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  const body: Problem = { type: "about:blank", title, status, ...extra };
  return {
    statusCode: status,
    headers: { ...BASE_HEADERS, "content-type": "application/problem+json", ...headers },
    body: JSON.stringify(body),
  };
}
