import { Buffer } from "node:buffer";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/** A web-standard Request for an API Gateway HTTP API (payload v2) event. */
export function toRequest(event: APIGatewayProxyEventV2): Request {
  const { domainName, http } = event.requestContext;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }
  const hasBody = event.body !== undefined && http.method !== "GET" && http.method !== "HEAD";
  let body: string | Uint8Array | undefined;
  if (hasBody && event.body !== undefined) {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }
  return new Request(`https://${domainName}${event.rawPath}${query}`, {
    method: http.method,
    headers,
    body,
  });
}

/** Reads a (non-streaming) web Response into an API Gateway result. */
export async function fromResponse(
  res: Response,
  extraHeaders: Record<string, string> = {},
): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    statusCode: res.status,
    headers: { ...headers, ...extraHeaders },
    body: await res.text(),
  };
}
