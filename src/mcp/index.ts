import { Buffer } from "node:buffer";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createDocClient, DynamoStore, type Store } from "../api/store.js";
import { VERSION, VERSION_HEADER } from "../shared/build-info.js";
import { json, problem } from "../shared/http.js";
import { bearerToken, cognitoKeys, SCOPES, type Verified, verifyAccessToken } from "./auth.js";
import { fromResponse, toRequest } from "./lambda-http.js";
import { registerReadTools, type ToolDeps } from "./tools-read.js";
import { registerWriteTools } from "./tools-write.js";

export const MCP_PATH = "/mcp";
const METADATA_PATH = "/.well-known/oauth-protected-resource";

const INSTRUCTIONS = `Láidir is the user's gym tracker. These tools read and change the same data the Láidir app shows; changes reach the app the next time it syncs.
Use the app's words with the user:
- A Program (e.g. "Push Pull Legs") groups Workouts. Tools: list_programs, create_program, update_program, delete_program.
- A Workout (e.g. "Push Day") is a plan the user starts in the app: ordered exercises with target sets. Tools: get_workout, create_workout, update_workout, delete_workout. Create a Program first, then each Workout with its program_id.
- A Session is one logged training session (the app's History). Tools: list_sessions, get_session, get_exercise_history. Sessions are read-only here.
Weights are stored in kg; weight_unit_preference says how the user likes to see them, so convert when you talk to them.
Exercises are referenced by id: "builtin:<slug>" for the built-in catalogue or a UUID for the user's own. Use search_exercises to find ids; never invent them.
Before update_workout with exercises, read the workout with get_workout: a new exercises list replaces the old one. Ask before deleting anything.`;

export interface McpDeps {
  store: () => Store;
  now: () => Date;
  issuer: () => string;
  verify: (token: string, resource: string) => Promise<Verified>;
  /** Overrides the stall deadline (tests). */
  deadlineMs?: number;
}

/** One McpServer per request (stateless), bound to the verified caller. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: "laidir", title: "Láidir", version: VERSION },
    {
      instructions: INSTRUCTIONS,
      // The tool list only changes on deploy, and Lambda can't hold the stream that
      // subscriptions/listen needs, so don't invite clients to listen for changes.
      capabilities: { tools: { listChanged: false } },
    },
  );
  registerReadTools(server, deps);
  registerWriteTools(server, deps);
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

const log = (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>) => {
  // No request bodies or tokens in logs.
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "info") console.log(line);
  else console[level](line);
};

const errorText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/** Longest a /mcp request may take before it's logged and answered as stalled. */
const DEADLINE_MS = 10_000;

/** What a request is, for logs: HTTP method, JSON-RPC method names and protocol version only. */
export function describeRequest(event: APIGatewayProxyEventV2) {
  let rpc: string[];
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    const messages = Array.isArray(parsed) ? parsed : parsed === undefined ? [] : [parsed];
    rpc = messages.map((m) => {
      const message = m as { method?: unknown; params?: { name?: unknown } } | null;
      const name = typeof message?.method === "string" ? message.method : "(response)";
      const tool = message?.params?.name;
      return name === "tools/call" && typeof tool === "string" ? `${name}:${tool}` : name;
    });
  } catch {
    rpc = ["(unparseable)"];
  }
  return {
    http: event.requestContext.http.method,
    rpc,
    protocol: event.headers["mcp-protocol-version"] ?? "(none)",
    bytes: event.body?.length ?? 0,
    requestId: event.requestContext.requestId,
  };
}

/** The JSON-RPC id of a single-message body (for answering it directly), or null. */
function requestIdOf(event: APIGatewayProxyEventV2): string | number | null {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    const id = (JSON.parse(raw) as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** The request being handled, for the process-level hooks below. */
let inFlight: ReturnType<typeof describeRequest> | undefined;

// These only report; they don't change how the process behaves on a crash.
process.on("beforeExit", () => {
  // Node ran out of work while a request was still waiting: Lambda reports this as
  // "Runtime exited without providing a reason".
  if (inFlight) log("error", "event loop drained mid-request", inFlight);
});
process.on("uncaughtExceptionMonitor", (err, origin) => {
  log("error", "uncaught exception", { origin, error: errorText(err), request: inFlight });
});

class Stalled extends Error {
  override name = "Stalled";
}

/** Resolves like `work`, or rejects with Stalled after `ms`. Keeps the event loop busy meanwhile. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Stalled(`no response after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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

    const info = describeRequest(event);
    // subscriptions/listen asks for a stream that stays open; Lambda returns whole responses
    // only, so it would wait forever (this was the "Runtime exited" crash). Decline it at once,
    // the way the SDK answers any method a server doesn't offer.
    if (info.rpc.length === 1 && info.rpc[0] === "subscriptions/listen") {
      log("info", "mcp request", { ...info, status: 404, ms: 0, declined: true });
      return json(
        404,
        {
          jsonrpc: "2.0",
          id: requestIdOf(event),
          error: { code: -32601, message: "Method not found: this server can't stream changes" },
        },
        VERSION_HEADER,
      );
    }
    const started = Date.now();
    inFlight = info;
    try {
      const result = await withDeadline(
        (async () => {
          const res = await mcp.fetch(toRequest(event), { authInfo: verified.auth });
          return fromResponse(res, { ...VERSION_HEADER, "cache-control": "no-store" });
        })(),
        deps.deadlineMs ?? DEADLINE_MS,
      );
      log("info", "mcp request", { ...info, status: result.statusCode, ms: Date.now() - started });
      return result;
    } catch (err) {
      const stalled = err instanceof Stalled;
      log("error", stalled ? "mcp request stalled" : "mcp request failed", {
        ...info,
        ms: Date.now() - started,
        error: errorText(err),
      });
      return problem(
        stalled ? 504 : 500,
        stalled ? "Gateway Timeout" : "Internal Server Error",
        { detail: "Something went wrong. Retrying is safe." },
        VERSION_HEADER,
      );
    } finally {
      inFlight = undefined;
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
