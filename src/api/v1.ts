import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { components } from "../generated/openapi.js";
import { VERSION_HEADER } from "../shared/build-info.js";
import { json, problem } from "../shared/http.js";
import type { Accounts } from "./accounts.js";
import { callerSub, callerUsername } from "./auth.js";
import { type Entity, type EntityType, isEntityType, validateEntity } from "./entities.js";
import type { Store } from "./store.js";

type PullResponse = components["schemas"]["PullResponse"];
type PushResult = components["schemas"]["PushResult"];
type PushResponse = components["schemas"]["PushResponse"];

export interface V1Deps {
  store: () => Store;
  accounts: () => Accounts;
  now: () => Date;
  allowedClientIds: () => readonly string[];
}

/** Pull only returns writes at least this old, so it can't overtake writes still in flight. */
export const SETTLE_MS = 2000;
export const MAX_PUSH_ITEMS = 25;
/** Request body cap (API Gateway allows 10 MB; 25 items never need this much). */
export const MAX_BODY_BYTES = 1_048_576;
/** Stay well under DynamoDB's 400 KB item limit (keys and attribute names count too). */
export const MAX_ITEM_BYTES = 350_000;
const PULL_LIMIT_DEFAULT = 100;
const PULL_LIMIT_MAX = 200;

const reply = (status: number, body: unknown) => json(status, body, VERSION_HEADER);
const fail = (status: number, title: string, detail?: string) =>
  problem(status, title, detail === undefined ? {} : { detail }, VERSION_HEADER);

/**
 * Routes for `ANY /v1/{proxy+}`. Only called when API Gateway matched that route, so its JWT
 * authorizer has already run.
 */
export async function routeV1(
  event: APIGatewayProxyEventV2,
  deps: V1Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  const sub = callerSub(event, deps.allowedClientIds());
  if (!sub) return fail(401, "Unauthorized", "A valid Láidir access token is required.");

  const { method, path } = event.requestContext.http;
  const route = `${method} ${path.replace(/\/+$/, "")}`;
  switch (route) {
    case "GET /v1/sync":
      return pull(event, sub, deps);
    case "POST /v1/sync":
      return push(event, sub, deps);
    case "GET /v1/profile":
      return getProfile(sub, deps);
    case "DELETE /v1/account":
      return deleteAccount(sub, callerUsername(event, sub), deps);
    default:
      return fail(404, "Not Found", `No route for ${method} ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Cursors: opaque to clients. "1." + base64url(feed position); "" position = from the start.
// ---------------------------------------------------------------------------

const POSITION =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#(PROFILE|EXERCISE|ROUTINE|ROUTINE_FOLDER|WORKOUT)#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const encodeCursor = (position: string): string =>
  `1.${Buffer.from(position, "utf8").toString("base64url")}`;

export function decodeCursor(cursor: string): string | undefined {
  if (!cursor.startsWith("1.")) return undefined;
  const position = Buffer.from(cursor.slice(2), "base64url").toString("utf8");
  if (position === "" || POSITION.test(position)) return position;
  return undefined;
}

// ---------------------------------------------------------------------------
// GET /v1/sync
// ---------------------------------------------------------------------------

async function pull(
  event: APIGatewayProxyEventV2,
  sub: string,
  deps: V1Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  const query = event.queryStringParameters ?? {};

  let after = "";
  if (query.cursor !== undefined && query.cursor !== "") {
    const decoded = query.cursor.length <= 512 ? decodeCursor(query.cursor) : undefined;
    if (decoded === undefined) return fail(400, "Bad Request", "cursor is not valid.");
    after = decoded;
  }

  let limit = PULL_LIMIT_DEFAULT;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!/^\d+$/.test(query.limit) || limit < 1 || limit > PULL_LIMIT_MAX) {
      return fail(
        400,
        "Bad Request",
        `limit must be an integer from 1 to ${String(PULL_LIMIT_MAX)}.`,
      );
    }
  }

  const before = new Date(deps.now().getTime() - SETTLE_MS).toISOString();
  const page = await deps.store().pull(sub, { after, before, limit });
  const last = page.rows.at(-1);
  const body: PullResponse = {
    items: page.rows.map((row) => row.entity),
    next_cursor: encodeCursor(last ? last.position : after),
    has_more: page.hasMore,
  };
  return reply(200, body);
}

// ---------------------------------------------------------------------------
// POST /v1/sync
// ---------------------------------------------------------------------------

async function push(
  event: APIGatewayProxyEventV2,
  sub: string,
  deps: V1Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  const raw = event.body ?? "";
  const text = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return fail(
      413,
      "Payload Too Large",
      `The body must be at most ${String(MAX_BODY_BYTES)} bytes.`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "Bad Request", "The body must be JSON.");
  }

  const items = readItems(body);
  if (typeof items === "string") return fail(400, "Bad Request", items);

  // Every item must at least say what it is, so each result can name it.
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const { id, type } = item as { id?: unknown; type?: unknown };
    if (typeof id !== "string" || id.length === 0 || id.length > 100 || !isEntityType(type)) {
      return fail(
        400,
        "Bad Request",
        `items[${String(index)}] needs a string id and a known type.`,
      );
    }
    const key = `${type}#${id}`;
    if (seen.has(key)) return fail(400, "Bad Request", `items has ${key} more than once.`);
    seen.add(key);
  }

  const store = deps.store();
  const results = await Promise.all(
    items.map((item) => pushOne(item as { id: string; type: EntityType }, sub, store, deps)),
  );
  const response: PushResponse = { results };
  return reply(200, response);
}

function readItems(body: unknown): unknown[] | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "The body must be an object with an items array.";
  }
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "items")) return "Unknown top-level field; only items is allowed.";
  const items: unknown = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return "items must be an array.";
  const list: unknown[] = items;
  if (list.length < 1 || list.length > MAX_PUSH_ITEMS) {
    return `items must hold 1 to ${String(MAX_PUSH_ITEMS)} entries.`;
  }
  return list;
}

async function pushOne(
  item: { id: string; type: EntityType },
  sub: string,
  store: Store,
  deps: V1Deps,
): Promise<PushResult> {
  const { id, type } = item;
  const invalid = (detail: string): PushResult => ({
    id,
    type,
    status: "invalid",
    problem: { type: "about:blank", title: "Invalid item", status: 422, detail },
  });

  const validation = validateEntity(type, item);
  if (!validation.ok) return invalid(validation.detail);
  const entity: Entity = validation.entity;

  if (entity.type === "PROFILE" && entity.id !== sub) {
    return invalid("A Profile's id must be the signed-in user's sub.");
  }
  if (Buffer.byteLength(JSON.stringify(entity), "utf8") > MAX_ITEM_BYTES) {
    return invalid(`The item is larger than ${String(MAX_ITEM_BYTES)} bytes.`);
  }

  const outcome = await store.put(sub, entity, deps.now().toISOString());
  if (outcome.status === "applied") return { id, type, status: "applied" };
  // A retried push of a write that already landed: same updated_at, so report it as applied.
  if (outcome.current.updated_at === entity.updated_at) return { id, type, status: "applied" };
  return { id, type, status: "stale", current: outcome.current };
}

// ---------------------------------------------------------------------------
// GET /v1/profile
// ---------------------------------------------------------------------------

async function getProfile(sub: string, deps: V1Deps): Promise<APIGatewayProxyStructuredResultV2> {
  const profile = await deps.store().getProfile(sub);
  if (!profile) return fail(404, "Not Found", "No profile yet; push one first.");
  return reply(200, profile);
}

// ---------------------------------------------------------------------------
// DELETE /v1/account
// ---------------------------------------------------------------------------

/**
 * Deletes the caller's account and every item they have. Order makes a retry safe after any
 * failure: sign out everywhere first (no device can push data back), then the data, then the
 * Cognito user. Each step treats "already gone" as done.
 */
async function deleteAccount(
  sub: string,
  username: string,
  deps: V1Deps,
): Promise<APIGatewayProxyStructuredResultV2> {
  const accounts = deps.accounts();
  await accounts.signOutEverywhere(username);
  const deleted = await deps.store().deleteAll(sub);
  await accounts.deleteUser(username);
  // Counts only: no identifiers in logs.
  console.log(JSON.stringify({ level: "info", msg: "account deleted", items: deleted }));
  return { statusCode: 204, headers: { ...VERSION_HEADER, "cache-control": "no-store" } };
}
