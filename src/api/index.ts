import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { components } from "../generated/openapi.js";
import { SCHEMA_VERSION, VERSION, VERSION_HEADER } from "../shared/build-info.js";
import { json, problem } from "../shared/http.js";
import { type Accounts, CognitoAccounts, createCognitoClient } from "./accounts.js";
import { allowedClientIdsFromEnv } from "./auth.js";
import { DynamoStore, createDocClient, type Store } from "./store.js";
import { routeV1, type V1Deps } from "./v1.js";

type Health = components["schemas"]["Health"];

/** The only route with API Gateway's JWT authorizer. /v1 logic runs only when this matched. */
export const V1_ROUTE_KEY = "ANY /v1/{proxy+}";

/**
 * REST API Lambda (laidir-<env>-api). API Gateway routes here:
 *   GET /health          public
 *   ANY /v1/{proxy+}     JWT authorizer (mobile + devtools clients) runs first
 *   $default             unmatched paths (no auth): always 404
 *
 * Never route /v1 on the raw path: a request to /v1/... can also arrive through `$default`
 * without a token. Only the route key proves the authorizer ran.
 */
export function createHandler(deps: V1Deps) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const { method, path } = event.requestContext.http;

    if (method === "GET" && path === "/health") {
      const body: Health = {
        status: "ok",
        service: "laidir-api",
        version: VERSION,
        schema_version: SCHEMA_VERSION,
      };
      return json(200, body, VERSION_HEADER);
    }

    if (event.requestContext.routeKey === V1_ROUTE_KEY) {
      try {
        return await routeV1(event, deps);
      } catch (err) {
        // No request bodies or tokens in logs.
        console.error(
          JSON.stringify({
            level: "error",
            msg: "v1 request failed",
            route: `${method} ${path}`,
            requestId: event.requestContext.requestId,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          }),
        );
        return problem(
          500,
          "Internal Server Error",
          { detail: "Something went wrong. Retrying is safe." },
          VERSION_HEADER,
        );
      }
    }

    return problem(404, "Not Found", { detail: `No route for ${method} ${path}` }, VERSION_HEADER);
  };
}

let store: Store | undefined;
let accounts: Accounts | undefined;

export const handler = createHandler({
  store: () => {
    if (!store) {
      const tableName = process.env.TABLE_NAME;
      if (!tableName) throw new Error("TABLE_NAME is not set");
      store = new DynamoStore(createDocClient(), tableName);
    }
    return store;
  },
  accounts: () => {
    if (!accounts) {
      const userPoolId = process.env.USER_POOL_ID;
      if (!userPoolId) throw new Error("USER_POOL_ID is not set");
      accounts = new CognitoAccounts(createCognitoClient(), userPoolId);
    }
    return accounts;
  },
  now: () => new Date(),
  allowedClientIds: () => allowedClientIdsFromEnv(),
});
