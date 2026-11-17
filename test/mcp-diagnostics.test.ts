import { describe, expect, it, vi } from "vitest";
import { createHandler, describeRequest } from "../src/mcp/index.js";
import { httpEvent, SUB_A } from "./event.js";
import { FakeStore } from "./fake-store.js";

const LEGACY = "2025-11-25";

function mcpEvent(body: unknown) {
  const event = httpEvent("POST", "/mcp");
  event.headers = {
    authorization: "Bearer t",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": LEGACY,
  };
  event.body = JSON.stringify(body);
  return event;
}

describe("describeRequest", () => {
  it("names the JSON-RPC methods and tools, never the arguments", () => {
    const info = describeRequest(
      mcpEvent([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_programs", arguments: { secret: "x" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    );
    expect(info).toMatchObject({
      http: "POST",
      rpc: ["tools/call:list_programs", "notifications/initialized"],
      protocol: LEGACY,
    });
    expect(JSON.stringify(info)).not.toContain("secret");
  });

  it("copes with bodies that aren't JSON", () => {
    const event = mcpEvent({});
    event.body = "{nope";
    expect(describeRequest(event).rpc).toEqual(["(unparseable)"]);
  });
});

describe("mcp handler: stalls and logging", () => {
  it("answers a request that never finishes with 504 and logs what it was", async () => {
    const store = new FakeStore();
    // A store call that never settles, like an awaited promise nothing will resolve.
    store.list = () => new Promise(() => undefined);
    const handler = createHandler({
      store: () => store,
      now: () => new Date(),
      issuer: () => "https://issuer.example",
      deadlineMs: 50,
      verify: (token) =>
        Promise.resolve({
          ok: true,
          sub: SUB_A,
          auth: { token, clientId: "c", scopes: [], extra: { sub: SUB_A } },
        }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handler(
      mcpEvent({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_programs", arguments: {} },
      }),
    );
    expect(res.statusCode).toBe(504);
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("mcp request stalled");
    expect(logged).toContain("tools/call:list_programs");
    errors.mockRestore();
  });
});
