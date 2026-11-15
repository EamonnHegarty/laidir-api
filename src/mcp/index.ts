import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { VERSION_HEADER } from "../shared/build-info.js";
import { problem } from "../shared/http.js";

/**
 * MCP Lambda (laidir-<env>-mcp). API Gateway routes here, with no authorizer:
 *   ANY /mcp
 *   GET /.well-known/oauth-protected-resource[/{proxy+}]
 *
 * Not implemented until phase 4. It deliberately returns 503 rather than 401, so Claude
 * doesn't start an OAuth flow against a server that can't serve it yet.
 */
export const handler = (): Promise<APIGatewayProxyStructuredResultV2> =>
  Promise.resolve(
    problem(
      503,
      "Service Unavailable",
      { detail: "The Láidir MCP server isn't available yet." },
      VERSION_HEADER,
    ),
  );
