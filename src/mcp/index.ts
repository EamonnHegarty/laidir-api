import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createDocClient, DynamoStore, type Store } from "../api/store.js";
import { VERSION, VERSION_HEADER } from "../shared/build-info.js";
import { json, problem } from "../shared/http.js";
import { bearerToken, cognitoKeys, SCOPES, type Verified, verifyAccessToken } from "./auth.js";
import { fromResponse, toRequest } from "./lambda-http.js";
import { registerReadTools, type ToolDeps } from "./tools-read.js";

export const MCP_PATH = "/mcp";
const METADATA_PATH = "/.well-known/oauth-protected-resource";

const INSTRUCTIONS = `Láidir is the user's gym tracker. These tools read and change the same data the Láidir app shows; changes reach the app the next time it syncs.
- Weights are stored in kg. weight_unit_preference says how the user likes to see them; convert when you talk to them.
- Exercises are referenced by id: "builtin:<slug>" for the built-in catalogue or a UUID for the user's own. Use search_exercises to find ids; never invent them.`;

export interface McpDeps {
  store: () => Store;
  now: () => Date;
  issuer: () => string;
  verify: (token: string, resource: string) => Promise<Verified>;
}

/** One McpServer per request (stateless), bound to the verified caller. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "laidir", title: "Láidir", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerReadTools(server, deps);
  return server;
}

/** RFC 9728 protected resource metadata for this MCP server. */
export function resourceMetadata(resource: string, issuer: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Láidir",
  };
}

function unauthorized(
  metadataUrl: string,
  invalidToken: boolean,
): APIGatewayProxyStructuredResultV2 {
  const params = [
    ...(invalidToken ? ['error="invalid_token"'] : []),
    `resource_metadata="${metadataUrl}"`,
    `scope="${SCOPES.join(" ")}"`,
  ];
  return problem(
    401,
    "Unauthorized",
    { detail: "Sign in to Láidir to use this connector." },
    { ...VERSION_HEADER, "www-authenticate": `Bearer ${params.join(", ")}` },
  );
}

const log = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => {
  // No request bodies or tokens in logs.
  console[level](JSON.stringify({ level, msg, ...fields }));
};

const errorText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/**
 * MCP Lambda (laidir-<env>-mcp). API Gateway routes here, with no authorizer:
 *   ANY /mcp                                        MCP (Streamable HTTP), token verified here
 *   GET /.well-known/oauth-protected-resource[/…]   RFC 9728 metadata (public)
 *
 * URLs are built from the request's domain, so they match the host Claude used.
 */
export function createHandler(deps: McpDeps) {
  const mcp = createMcpHandler(
    (ctx) => {
      const sub = ctx.authInfo?.extra?.sub;
      if (typeof sub !== "string") throw new Error("MCP request without a verified caller");
      return createServer({ store: deps.store(), sub, now: deps.now });
    },
    {
      // Default "auto": plain JSON, since no tool sends progress or log notifications.
      maxRequestBodySize: 1024 * 1024,
      onerror: (err) => {
        log("error", "mcp error", { error: errorText(err) });
      },
    },
  );

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const { method, path } = event.requestContext.http;
    const requestId = event.requestContext.requestId;
    const origin = `https://${event.requestContext.domainName}`;
    const resource = `${origin}${MCP_PATH}`;
    const metadataUrl = `${origin}${METADATA_PATH}${MCP_PATH}`;

    if (path === METADATA_PATH || path === `${METADATA_PATH}${MCP_PATH}`) {
      return json(200, resourceMetadata(resource, deps.issuer()), {
        ...VERSION_HEADER,
        "cache-control": "public, max-age=300",
      });
    }
    if (path !== MCP_PATH) {
      return problem(
        404,
        "Not Found",
        { detail: `No route for ${method} ${path}` },
        VERSION_HEADER,
      );
    }

    // Claude only starts OAuth on a 401 that points at the metadata.
    const token = bearerToken(event.headers.authorization);
    if (!token) return unauthorized(metadataUrl, false);
    const verified = await deps.verify(token, resource);
    if (!verified.ok) {
      log("warn", "token rejected", { reason: verified.reason, requestId });
      return unauthorized(metadataUrl, true);
    }

    try {
      const res = await mcp.fetch(toRequest(event), { authInfo: verified.auth });
      return await fromResponse(res, { ...VERSION_HEADER, "cache-control": "no-store" });
    } catch (err) {
      log("error", "mcp request failed", { requestId, error: errorText(err) });
      return problem(
        500,
        "Internal Server Error",
        { detail: "Something went wrong." },
        VERSION_HEADER,
      );
    }
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

let store: Store | undefined;
let keys: ReturnType<typeof cognitoKeys> | undefined;

export const handler = createHandler({
  store: () => (store ??= new DynamoStore(createDocClient(), env("TABLE_NAME"))),
  now: () => new Date(),
  issuer: () => env("COGNITO_ISSUER"),
  verify: (token, resource) => {
    const issuer = env("COGNITO_ISSUER");
    keys ??= cognitoKeys(issuer);
    return verifyAccessToken(token, resource, {
      issuer,
      clientId: env("CLAUDE_CLIENT_ID"),
      keys,
    });
  },
});
