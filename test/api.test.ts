import { describe, expect, it } from "vitest";
import { handler } from "../src/api/index.js";
import { httpEvent } from "./event.js";

describe("api handler", () => {
  it("GET /health returns 200 with the version", async () => {
    const res = await handler(httpEvent("GET", "/health"));
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-laidir-version": "dev",
    });
    expect(JSON.parse(res.body ?? "")).toEqual({
      status: "ok",
      service: "laidir-api",
      version: "dev",
      schema_version: 1,
    });
  });

  it("returns a 404 problem for unknown routes", async () => {
    const res = await handler(httpEvent("GET", "/v1/nope"));
    expect(res.statusCode).toBe(404);
    expect(res.headers).toMatchObject({ "content-type": "application/problem+json" });
    expect(JSON.parse(res.body ?? "")).toMatchObject({ status: 404, title: "Not Found" });
  });

  it("only answers GET on /health", async () => {
    expect((await handler(httpEvent("POST", "/health"))).statusCode).toBe(404);
  });
});
