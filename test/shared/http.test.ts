import { describe, expect, it } from "vitest";
import { json, problem } from "../../src/shared/http.js";

describe("json", () => {
  it("serialises the body with JSON and no-store headers", () => {
    const res = json(200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    expect(JSON.parse(res.body ?? "")).toEqual({ ok: true });
  });

  it("lets callers add headers", () => {
    expect(json(200, {}, { "x-extra": "1" }).headers).toMatchObject({ "x-extra": "1" });
  });
});

describe("problem", () => {
  it("returns RFC 9457 problem details", () => {
    const res = problem(404, "Not Found", { detail: "No route for GET /nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers).toMatchObject({ "content-type": "application/problem+json" });
    expect(JSON.parse(res.body ?? "")).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "No route for GET /nope",
    });
  });
});
