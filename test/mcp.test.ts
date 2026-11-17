import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { bearerToken, type VerifyConfig, verifyAccessToken } from "../src/mcp/auth.js";
import { createHandler } from "../src/mcp/index.js";
import { httpEvent, SUB_A, SUB_B } from "./event.js";
import { FakeStore } from "./fake-store.js";

const ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test";
const CLAUDE = "claudeclient123";
const ORIGIN = "https://test.execute-api.eu-west-1.amazonaws.com";
const RESOURCE = `${ORIGIN}/mcp`;
const NOW = "2026-11-17T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Token verification (real jose, local keys)
// ---------------------------------------------------------------------------

describe("verifyAccessToken", () => {
  let cfg: VerifyConfig;
  let sign: (claims: Record<string, unknown>, opts?: { exp?: string }) => Promise<string>;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    cfg = { issuer: ISSUER, clientId: CLAUDE, keys: createLocalJWKSet({ keys: [jwk] }) };
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? "1h")
        .sign(privateKey);
  });

  const good = {
    sub: SUB_A,
    token_use: "access",
    client_id: CLAUDE,
    scope: "openid email profile",
    aud: RESOURCE,
  };

  it("accepts a Claude access token issued for this server", async () => {
    const result = await verifyAccessToken(await sign(good), RESOURCE, cfg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sub).toBe(SUB_A);
    expect(result.auth).toMatchObject({
      clientId: CLAUDE,
      scopes: ["openid", "email", "profile"],
      extra: { sub: SUB_A },
    });
    expect(result.auth.resource?.href).toBe(RESOURCE);
  });

  it.each([
    ["an ID token", { token_use: "id" }, "not an access token"],
    ["another client's token", { client_id: "mobileclient" }, "wrong client"],
    ["a token for another resource", { aud: "https://example.com/mcp" }, "wrong audience"],
    ["a token without an audience", { aud: undefined }, "wrong audience"],
    ["a non-UUID sub", { sub: "admin" }, "bad sub"],
  ])("rejects %s", async (_, override, reason) => {
    const result = await verifyAccessToken(await sign({ ...good, ...override }), RESOURCE, cfg);
    expect(result).toEqual({ ok: false, reason });
  });

  it("rejects an expired token", async () => {
    const result = await verifyAccessToken(await sign(good, { exp: "-1h" }), RESOURCE, cfg);
    expect(result).toEqual({ ok: false, reason: "ERR_JWT_EXPIRED" });
  });

  it("rejects a token signed by someone else", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT(good)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setExpirationTime("1h")
      .sign(other.privateKey);
    const result = await verifyAccessToken(forged, RESOURCE, cfg);
    expect(result.ok).toBe(false);
  });

  it("parses bearer headers", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Handler (fake verifier: "token-a" is SUB_A, "token-b" is SUB_B)
// ---------------------------------------------------------------------------

function setup() {
  const store = new FakeStore();
  const handler = createHandler({
    store: () => store,
    now: () => new Date(NOW),
    issuer: () => ISSUER,
    verify: (token, resource) => {
      const sub = ({ "token-a": SUB_A, "token-b": SUB_B } as Record<string, string>)[token];
      if (!sub || resource !== RESOURCE) return Promise.resolve({ ok: false, reason: "test" });
      return Promise.resolve({
        ok: true,
        sub,
        auth: { token, clientId: CLAUDE, scopes: [], extra: { sub } },
      });
    },
  });
  return { store, handler };
}

type Handler = ReturnType<typeof setup>["handler"];

function mcpEvent(body: unknown, token?: string, headers: Record<string, string> = {}) {
  const event: APIGatewayProxyEventV2 = httpEvent("POST", "/mcp");
  event.routeKey = "ANY /mcp";
  event.requestContext.routeKey = "ANY /mcp";
  event.headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  event.body = JSON.stringify(body);
  return event;
}

const LEGACY_VERSION = "2025-11-25";
const MODERN_VERSION = "2026-07-28";

/** A 2026-07-28 request: version and client info travel on every request. */
function modern(id: number, method: string, params: Record<string, unknown> = {}) {
  return {
    body: {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    headers: {
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
  };
}

interface RpcResponse {
  result?: { content?: { text: string }[]; isError?: boolean; tools?: unknown[] };
  error?: unknown;
}

async function call(
  handler: Handler,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResponse> {
  const req = modern(1, method, params);
  const res = await handler(mcpEvent(req.body, token, req.headers));
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body ?? "{}") as RpcResponse;
}

async function tool(
  handler: Handler,
  name: string,
  args: Record<string, unknown> = {},
  token = "token-a",
) {
  const out = await call(handler, token, "tools/call", { name, arguments: args });
  expect(out.error).toBeUndefined();
  const text = out.result?.content?.[0]?.text ?? "";
  return { isError: out.result?.isError === true, text, data: safeJson(text) };
}

/** A JSON body, or the JSON-RPC message in a complete SSE body (legacy responses). */
function parseRpc(body: string | undefined): unknown {
  const text = body ?? "";
  const data = /^data: (.*)$/m.exec(text);
  return JSON.parse(data?.[1] ?? text);
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

describe("mcp handler: discovery and auth", () => {
  it.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])(
    "serves protected resource metadata at %s",
    async (path) => {
      const { handler } = setup();
      const res = await handler(httpEvent("GET", path));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body ?? "")).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ["openid", "email", "profile"],
        bearer_methods_supported: ["header"],
        resource_name: "Láidir",
      });
    },
  );

  it("answers /mcp without a token with 401 pointing at the metadata", async () => {
    const { handler } = setup();
    const res = await handler(mcpEvent({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["www-authenticate"]).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="openid email profile"`,
    );
    expect(res.headers?.["x-laidir-version"]).toBe("dev");
  });

  it("answers a bad token with 401 invalid_token", async () => {
    const { handler } = setup();
    const res = await handler(mcpEvent({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "nope"));
    expect(res.statusCode).toBe(401);
    expect(res.headers?.["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("404s other paths", async () => {
    const { handler } = setup();
    const res = await handler(httpEvent("GET", "/.well-known/oauth-protected-resource/x"));
    expect(res.statusCode).toBe(404);
  });
});

describe("mcp handler: protocol", () => {
  it("serves legacy (2025-era) clients: initialize, then tools/list", async () => {
    const { handler } = setup();
    const init = await handler(
      mcpEvent(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LEGACY_VERSION,
            capabilities: {},
            clientInfo: { name: "claude-ai", version: "1.0" },
          },
        },
        "token-a",
      ),
    );
    expect(init.statusCode, init.body).toBe(200);
    const initBody = parseRpc(init.body) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("laidir");

    const list = await handler(
      mcpEvent({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "token-a", {
        "mcp-protocol-version": LEGACY_VERSION,
      }),
    );
    expect(list.statusCode, list.body).toBe(200);
    const listBody = parseRpc(list.body) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((t) => t.name)).toContain("list_routines");
  });

  it("serves modern (2026-07-28) clients and annotates every tool", async () => {
    const { handler } = setup();
    const out = await call(handler, "token-a", "tools/list");
    const tools = out.result?.tools as {
      name: string;
      title?: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_exercise_history",
      "get_routine",
      "get_workout",
      "list_routines",
      "list_workouts",
      "search_exercises",
    ]);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      const annotated =
        t.annotations?.readOnlyHint === true || t.annotations?.destructiveHint !== undefined;
      expect(annotated, t.name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const FOLDER_ID = "44444444-4444-4444-8444-444444444444";
const WORKOUT_1 = "55555555-5555-4555-8555-555555555555";
const WORKOUT_2 = "66666666-6666-4666-8666-666666666666";
const CUSTOM_EX = "77777777-7777-4777-8777-777777777777";

const base = (type: string, id: string) => ({
  id,
  type,
  schema_version: 1,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  deleted_at: null,
});

async function seed(store: FakeStore, sub = SUB_A) {
  const put = (item: Record<string, unknown>) =>
    store.put(sub, item as never, "2026-11-01T10:00:00.000Z");
  await put({ ...base("PROFILE", sub), weight_unit: "kg", distance_unit: "km" });
  await put({ ...base("ROUTINE_FOLDER", FOLDER_ID), name: "Upper/Lower", sort_order: 1000 });
  await put({
    ...base("ROUTINE", ROUTINE_ID),
    name: "Upper A",
    folder_id: FOLDER_ID,
    exercises: [
      {
        exercise_id: "builtin:barbell-bench-press",
        sets: [{ set_type: "normal", target_reps_min: 5, target_reps_max: 8 }],
      },
      { exercise_id: CUSTOM_EX, sets: [{ set_type: "normal" }] },
    ],
  });
  await put({
    ...base("ROUTINE", "88888888-8888-4888-8888-888888888888"),
    name: "Deleted",
    deleted_at: "2026-11-02T10:00:00.000Z",
    exercises: [],
  });
  await put({
    ...base("EXERCISE", CUSTOM_EX),
    name: "Laidir Special Press",
    equipment: "barbell",
    primary_muscle: "shoulders",
    tracking: "weight_reps",
  });
  const bench = (sets: { weight_kg: number; reps: number; set_type?: string }[]) => ({
    exercise_id: "builtin:barbell-bench-press",
    sets: sets.map((s) => ({ set_type: "normal", completed: true, ...s })),
  });
  await put({
    ...base("WORKOUT", WORKOUT_1),
    name: "Upper A",
    started_at: "2026-11-10T08:00:00.000Z",
    ended_at: "2026-11-10T09:00:00.000Z",
    exercises: [
      bench([
        { weight_kg: 40, reps: 10, set_type: "warmup" },
        { weight_kg: 80, reps: 5 },
        { weight_kg: 80, reps: 5 },
      ]),
    ],
  });
  await put({
    ...base("WORKOUT", WORKOUT_2),
    name: "Upper A",
    started_at: "2026-11-14T08:00:00.000Z",
    ended_at: "2026-11-14T09:10:00.000Z",
    exercises: [bench([{ weight_kg: 85, reps: 5 }])],
  });
}

describe("read tools", () => {
  it("search_exercises finds built-in and custom exercises", async () => {
    const { store, handler } = setup();
    await seed(store);
    const bench = await tool(handler, "search_exercises", { query: "bench barbell" });
    expect(bench.data.exercises).toContainEqual(
      expect.objectContaining({ id: "builtin:barbell-bench-press", custom: false }),
    );
    const mine = await tool(handler, "search_exercises", { query: "laidir special" });
    expect(mine.data.exercises).toEqual([expect.objectContaining({ id: CUSTOM_EX, custom: true })]);
    const shoulders = await tool(handler, "search_exercises", { muscle: "shoulders", limit: 200 });
    expect(shoulders.data.total).toBeGreaterThan(1);
  });

  it("list_routines groups live routines by folder", async () => {
    const { store, handler } = setup();
    await seed(store);
    const { data } = await tool(handler, "list_routines");
    expect(data).toEqual({
      folders: [
        {
          id: FOLDER_ID,
          name: "Upper/Lower",
          routines: [
            {
              id: ROUTINE_ID,
              name: "Upper A",
              exercises: 2,
              sets: 2,
              updated_at: "2026-11-01T10:00:00.000Z",
            },
          ],
        },
      ],
      unfiled: [],
    });
  });

  it("get_routine adds exercise names", async () => {
    const { store, handler } = setup();
    await seed(store);
    const { data } = await tool(handler, "get_routine", { routine_id: ROUTINE_ID });
    expect((data.exercises as { name: string }[]).map((e) => e.name)).toEqual([
      "Bench Press (Barbell)",
      "Laidir Special Press",
    ]);
  });

  it("list_workouts returns newest first with totals and honours dates", async () => {
    const { store, handler } = setup();
    await seed(store);
    const all = await tool(handler, "list_workouts");
    expect(all.data.workouts).toEqual([
      expect.objectContaining({
        id: WORKOUT_2,
        duration_min: 70,
        completed_sets: 1,
        volume_kg: 425,
      }),
      expect.objectContaining({
        id: WORKOUT_1,
        duration_min: 60,
        completed_sets: 2,
        volume_kg: 800,
      }),
    ]);
    const early = await tool(handler, "list_workouts", { to: "2026-11-10" });
    expect((early.data.workouts as { id: string }[]).map((w) => w.id)).toEqual([WORKOUT_1]);
    const late = await tool(handler, "list_workouts", { from: "2026-11-11" });
    expect((late.data.workouts as { id: string }[]).map((w) => w.id)).toEqual([WORKOUT_2]);
  });

  it("get_exercise_history reports sessions and the best set", async () => {
    const { store, handler } = setup();
    await seed(store);
    const { data } = await tool(handler, "get_exercise_history", {
      exercise_id: "builtin:barbell-bench-press",
    });
    expect(data.best_ever).toEqual({
      weight_kg: 85,
      reps: 5,
      e1rm_kg: 99.2,
      date: "2026-11-14T08:00:00.000Z",
    });
    expect(data.sessions).toHaveLength(2);
  });

  it("never shows another user's data", async () => {
    const { store, handler } = setup();
    await seed(store, SUB_A);
    const routines = await tool(handler, "list_routines", {}, "token-b");
    expect(routines.data).toEqual({ folders: [], unfiled: [] });
    const routine = await tool(handler, "get_routine", { routine_id: ROUTINE_ID }, "token-b");
    expect(routine.isError).toBe(true);
    const workout = await tool(handler, "get_workout", { workout_id: WORKOUT_1 }, "token-b");
    expect(workout.isError).toBe(true);
  });
});
