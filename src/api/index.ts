import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { components } from "../generated/openapi.js";
import { SCHEMA_VERSION, VERSION, VERSION_HEADER } from "../shared/build-info.js";
import { json, problem } from "../shared/http.js";

type Health = components["schemas"]["Health"];

/**
 * REST API Lambda (laidir-<env>-api). API Gateway routes here:
 *   GET /health          public
 *   ANY /v1/{proxy+}     JWT authorizer (mobile client) runs first
 */
export const handler = (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const { method, path } = event.requestContext.http;

  if (method === "GET" && path === "/health") {
    const body: Health = {
      status: "ok",
      service: "laidir-api",
      version: VERSION,
      schema_version: SCHEMA_VERSION,
    };
    return Promise.resolve(json(200, body, VERSION_HEADER));
  }

  return Promise.resolve(
    problem(404, "Not Found", { detail: `No route for ${method} ${path}` }, VERSION_HEADER),
  );
};
