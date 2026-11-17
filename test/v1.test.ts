import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Accounts } from "../src/api/accounts.js";
import type { Entity } from "../src/api/entities.js";
import { createHandler } from "../src/api/index.js";
import type { Store } from "../src/api/store.js";
import { MAX_BODY_BYTES, SETTLE_MS, decodeCursor, encodeCursor } from "../src/api/v1.js";
import { MOBILE_CLIENT, SUB_A, SUB_B, httpEvent, v1Event } from "./event.js";
import { FakeStore } from "./fake-store.js";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "v1", "valid", name), "utf8"),
  ) as Record<string, unknown>;

const EXERCISE = fixture("exercise.json");
const WORKOUT = fixture("workout.full.json");
const PROFILE_A = { ...fixture("profile.json"), id: SUB_A };

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const exerciseN = (n: number, updatedAt = "2026-11-16T10:00:00.000Z") => ({
  ...EXERCISE,
  id: uuid(n),
  name: `Exercise ${String(n)}`,
  updated_at: updatedAt,
});

let store: FakeStore;
let accounts: { calls: string[] } & Accounts;
let clock: Date;
let handler: ReturnType<typeof createHandler>;

function fakeAccounts(): { calls: string[] } & Accounts {
  const calls: string[] = [];
  return {
    calls,
    signOutEverywhere: (username) => {
      calls.push(`signOut ${username}`);
      return Promise.resolve();
    },
    deleteUser: (username) => {
      calls.push(`delete ${username}`);
      return Promise.resolve();
    },
  };
}

const tick = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const settle = () => {
  tick(SETTLE_MS + 1);
};
const body = (res: { body?: string }) => JSON.parse(res.body ?? "") as Record<string, unknown>;

async function push(items: unknown[], sub = SUB_A) {
  return handler(v1Event("POST", "/v1/sync", { sub, body: { items } }));
}
async function pull(query: Record<string, string> = {}, sub = SUB_A) {
  return handler(v1Event("GET", "/v1/sync", { sub, query }));
}

beforeEach(() => {
  store = new FakeStore();
  accounts = fakeAccounts();
  clock = new Date("2026-11-16T12:00:00.000Z");
  handler = createHandler({
    store: () => store,
    accounts: () => accounts,
    now: () => clock,
    allowedClientIds: () => [MOBILE_CLIENT],
  });
});

describe("/v1 auth and routing", () => {
  it("only runs /v1 logic on the authorized route key", async () => {
    // Same path, but arriving through the unauthenticated $default route.
    const event = httpEvent("GET", "/v1/sync");
    event.routeKey = "$default";
    event.requestContext.routeKey = "$default";
    const spy = vi.spyOn(store, "pull");
    const res = await handler(event);
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["no authorizer context", null],
    ["an id token", { sub: SUB_A, token_use: "id", client_id: MOBILE_CLIENT }],
    ["another client", { sub: SUB_A, token_use: "access", client_id: "someoneelse" }],
    ["a non-UUID sub", { sub: "admin", token_use: "access", client_id: MOBILE_CLIENT }],
  ])("returns 401 for %s", async (_label, claims) => {
    const res = await handler(v1Event("GET", "/v1/sync", { claims }));
    expect(res.statusCode).toBe(401);
    expect(res.headers).toMatchObject({ "content-type": "application/problem+json" });
  });

  it("returns 404 for unknown /v1 routes", async () => {
    expect((await handler(v1Event("GET", "/v1/nope"))).statusCode).toBe(404);
    expect((await handler(v1Event("DELETE", "/v1/sync"))).statusCode).toBe(404);
  });

  it("returns a 500 problem (no details) when the store fails", async () => {
    const failing: Store = {
      put: () => Promise.reject(new Error("boom")),
      pull: () => Promise.reject(new Error("boom")),
      getProfile: () => Promise.reject(new Error("boom")),
      deleteAll: () => Promise.reject(new Error("boom")),
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = createHandler({
      store: () => failing,
      accounts: () => fakeAccounts(),
      now: () => clock,
      allowedClientIds: () => [MOBILE_CLIENT],
    });
    const res = await h(v1Event("GET", "/v1/profile"));
    expect(res.statusCode).toBe(500);
    expect(body(res)).toMatchObject({ status: 500, title: "Internal Server Error" });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});

describe("POST /v1/sync", () => {
  it("applies new items and stamps synced_at server-side", async () => {
    const res = await push([EXERCISE, WORKOUT]);
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      results: [
        { id: EXERCISE.id, type: "EXERCISE", status: "applied" },
        { id: WORKOUT.id, type: "WORKOUT", status: "applied" },
      ],
    });
    const row = [...store.rows.values()].find((r) => r.id === WORKOUT.id);
    expect(row).toMatchObject({
      PK: `USER#${SUB_A}`,
      SK: `WORKOUT#${String(WORKOUT.id)}`,
      GSI1PK: `USER#${SUB_A}#WORKOUT`,
      GSI2SK: `${clock.toISOString()}#WORKOUT#${String(WORKOUT.id)}`,
      synced_at: clock.toISOString(),
    });
  });

  it("last writer wins on updated_at; an older write is stale with the server copy", async () => {
    const newer = exerciseN(1, "2026-11-16T11:00:00.000Z");
    const older = { ...exerciseN(1, "2026-11-16T10:00:00.000Z"), name: "Old name" };
    await push([newer]);
    const res = await push([older]);
    expect(body(res)).toEqual({
      results: [{ id: newer.id, type: "EXERCISE", status: "stale", current: newer }],
    });
  });

  it("treats a retry of the same write as applied (idempotent)", async () => {
    await push([EXERCISE]);
    const res = await push([EXERCISE]);
    expect(body(res)).toEqual({
      results: [{ id: EXERCISE.id, type: "EXERCISE", status: "applied" }],
    });
  });

  it("reports invalid items without failing the rest", async () => {
    const res = await push([{ ...exerciseN(1), colour: "red" }, exerciseN(2)]);
    const { results } = body(res) as { results: Record<string, unknown>[] };
    expect(results[0]).toMatchObject({
      id: uuid(1),
      type: "EXERCISE",
      status: "invalid",
      problem: { status: 422, title: "Invalid item" },
    });
    expect(results[1]).toEqual({ id: uuid(2), type: "EXERCISE", status: "applied" });
  });

  it("only accepts the caller's own Profile", async () => {
    const other = { ...PROFILE_A, id: SUB_B };
    const res = await push([other, PROFILE_A]);
    const { results } = body(res) as { results: Record<string, unknown>[] };
    expect(results[0]).toMatchObject({ status: "invalid" });
    expect(results[1]).toMatchObject({ status: "applied" });
  });

  it("keeps tenants apart even when IDs collide", async () => {
    await push([exerciseN(1)], SUB_A);
    const res = await push([{ ...exerciseN(1, "2026-01-01T00:00:00.000Z"), name: "B's" }], SUB_B);
    expect(body(res)).toMatchObject({ results: [{ status: "applied" }] });
    settle();
    const a = body(await pull({}, SUB_A)) as { items: { name: string }[] };
    const b = body(await pull({}, SUB_B)) as { items: { name: string }[] };
    expect(a.items.map((i) => i.name)).toEqual(["Exercise 1"]);
    expect(b.items.map((i) => i.name)).toEqual(["B's"]);
  });

  it("accepts a base64-encoded body", async () => {
    const res = await handler(
      v1Event("POST", "/v1/sync", { body: { items: [EXERCISE] }, base64: true }),
    );
    expect(body(res)).toMatchObject({ results: [{ status: "applied" }] });
  });

  it.each([
    ["not JSON", { rawBody: "{nope" }],
    ["not an object", { body: [EXERCISE] }],
    ["an unknown top-level field", { body: { items: [EXERCISE], force: true } }],
    ["no items", { body: { items: [] } }],
    ["more than 25 items", { body: { items: Array.from({ length: 26 }, (_, i) => exerciseN(i)) } }],
    ["an item without a type", { body: { items: [{ id: uuid(1) }] } }],
    ["an unknown type", { body: { items: [{ ...EXERCISE, type: "FRIEND" }] } }],
    ["the same item twice", { body: { items: [EXERCISE, EXERCISE] } }],
  ])("returns 400 for %s", async (_label, opts) => {
    const res = await handler(v1Event("POST", "/v1/sync", opts));
    expect(res.statusCode).toBe(400);
    expect(res.headers).toMatchObject({ "content-type": "application/problem+json" });
    expect(store.rows.size).toBe(0);
  });

  it("returns 413 for an oversized body", async () => {
    const res = await handler(
      v1Event("POST", "/v1/sync", { rawBody: " ".repeat(MAX_BODY_BYTES + 1) }),
    );
    expect(res.statusCode).toBe(413);
  });
});

describe("GET /v1/sync", () => {
  it("only returns settled writes, then nothing new from the final cursor", async () => {
    await push([EXERCISE]);
    const early = body(await pull());
    expect(early).toMatchObject({ items: [], has_more: false });

    settle();
    const first = body(await pull());
    expect(first.items).toEqual([EXERCISE]);
    expect(first.has_more).toBe(false);

    const again = body(await pull({ cursor: String(first.next_cursor) }));
    expect(again).toEqual({ items: [], has_more: false, next_cursor: first.next_cursor });
  });

  it("orders by the server's clock, so a device with a wrong clock can't hide changes", async () => {
    await push([exerciseN(1, "2026-11-16T10:00:00.000Z")]);
    settle();
    const { next_cursor } = body(await pull());

    // Another device's clock is a year behind: its updated_at is old, but the write is new.
    tick(1000);
    await push([exerciseN(2, "2025-11-16T10:00:00.000Z")]);
    settle();
    const later = body(await pull({ cursor: String(next_cursor) })) as { items: Entity[] };
    expect(later.items.map((i) => i.id)).toEqual([uuid(2)]);
  });

  it("pages with next_cursor until has_more is false", async () => {
    for (let n = 1; n <= 5; n++) {
      await push([exerciseN(n)]);
      tick(1);
    }
    settle();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = body(await pull(cursor ? { cursor, limit: "2" } : { limit: "2" })) as {
        items: Entity[];
        next_cursor: string;
        has_more: boolean;
      };
      pages++;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5].map(uuid));
    expect(pages).toBe(3);
  });

  it("includes tombstones", async () => {
    await push([{ ...EXERCISE, deleted_at: "2026-11-16T09:00:00.000Z" }]);
    settle();
    expect(body(await pull()).items).toEqual([
      { ...EXERCISE, deleted_at: "2026-11-16T09:00:00.000Z" },
    ]);
  });

  it.each([
    ["a malformed cursor", { cursor: "garbage" }],
    ["a cursor with a bad position", { cursor: encodeCursor("USER#someone-else") }],
    ["limit 0", { limit: "0" }],
    ["limit 201", { limit: "201" }],
    ["a fractional limit", { limit: "1.5" }],
  ])("returns 400 for %s", async (_label, query) => {
    expect((await pull(query)).statusCode).toBe(400);
  });

  it("round-trips cursors", () => {
    const position = `2026-11-16T12:00:00.000Z#PROFILE#${SUB_A}`;
    expect(decodeCursor(encodeCursor(position))).toBe(position);
    expect(decodeCursor(encodeCursor(""))).toBe("");
  });
});

describe("GET /v1/profile", () => {
  it("is 404 until the first profile push, then returns it", async () => {
    expect((await handler(v1Event("GET", "/v1/profile"))).statusCode).toBe(404);
    await push([PROFILE_A]);
    const res = await handler(v1Event("GET", "/v1/profile"));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual(PROFILE_A);
  });

  it("never returns another user's profile", async () => {
    await push([PROFILE_A]);
    expect((await handler(v1Event("GET", "/v1/profile", { sub: SUB_B }))).statusCode).toBe(404);
  });
});

describe("DELETE /v1/account", () => {
  const deleteEvent = (sub = SUB_A, username?: string) => {
    const claims = {
      sub,
      token_use: "access",
      client_id: MOBILE_CLIENT,
      ...(username ? { username } : {}),
    };
    return v1Event("DELETE", "/v1/account", { claims });
  };

  it("signs out everywhere, deletes all the caller's data, then the user, and nobody else's", async () => {
    await push([PROFILE_A, EXERCISE, WORKOUT], SUB_A);
    await push([exerciseN(9)], SUB_B);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await handler(deleteEvent(SUB_A, "cognito-username-a"));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(accounts.calls).toEqual(["signOut cognito-username-a", "delete cognito-username-a"]);

    settle();
    expect(body(await pull({}, SUB_A))).toMatchObject({ items: [] });
    expect((await handler(v1Event("GET", "/v1/profile"))).statusCode).toBe(404);
    expect((body(await pull({}, SUB_B)) as { items: unknown[] }).items).toHaveLength(1);
    // The log line has a count, never an identifier.
    expect(JSON.stringify(logs.mock.calls)).not.toContain(SUB_A);
    logs.mockRestore();
  });

  it("falls back to the sub when the token has no username claim", async () => {
    await handler(deleteEvent(SUB_A));
    expect(accounts.calls).toEqual([`signOut ${SUB_A}`, `delete ${SUB_A}`]);
  });

  it("is safe to retry after a failure (no data left, user deleted on the retry)", async () => {
    await push([EXERCISE]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failOnce = true;
    accounts.deleteUser = () => {
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new Error("AccessDenied"));
      }
      accounts.calls.push("delete");
      return Promise.resolve();
    };
    expect((await handler(deleteEvent())).statusCode).toBe(500);
    expect(store.rows.size).toBe(0);
    expect((await handler(deleteEvent())).statusCode).toBe(204);
    expect(accounts.calls).toContain("delete");
    errors.mockRestore();
  });
});
