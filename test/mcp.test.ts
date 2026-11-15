import { describe, expect, it } from "vitest";
import { handler } from "../src/mcp/index.js";

describe("mcp handler (phase 1 stub)", () => {
  // Every route (/mcp, /.well-known/...) gets the same answer until phase 4.
  it("returns 503, not 401, so Claude doesn't start an OAuth flow", async () => {
    const res = await handler();
    expect(res.statusCode).toBe(503);
    expect(res.headers).toMatchObject({
      "content-type": "application/problem+json",
      "x-laidir-version": "dev",
    });
    expect(res.headers).not.toHaveProperty("www-authenticate");
  });
});
