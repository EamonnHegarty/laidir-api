import { describe, expect, it, vi } from "vitest";
import { createHandler, handler } from "../src/api/index.js";
import { cognitoDiscovery, clearDiscoveryCache } from "../src/shared/auth-server-metadata.js";
import { httpEvent } from "./event.js";
import { FakeStore } from "./fake-store.js";

const ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_test";
const AUTH = "https://laidir-test.auth.eu-west-1.amazoncognito.com";
// The parts of Cognito's real discovery document that matter here.
const COGNITO = {
  issuer: ISSUER,
  authorization_endpoint: `${AUTH}/oauth2/authorize`,
  token_endpoint: `${AUTH}/oauth2/token`,
  revocation_endpoint: `${AUTH}/oauth2/revoke`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  scopes_supported: ["openid", "email", "phone", "profile"],
};

function withDiscovery(discovery: () => Promise<Record<string, unknown>>) {
  return createHandler({
    store: () => new FakeStore(),
    accounts: () => {
      throw new Error("unused");
    },
    now: () => new Date(),
    allowedClientIds: () => [],
    cognitoDiscovery: discovery,
  });
}

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

  it("serves the connector's authorization server metadata: Cognito's, three fields changed", async () => {
    const h = withDiscovery(() => Promise.resolve(COGNITO));
    const res = await h(httpEvent("GET", "/.well-known/oauth-authorization-server"));
    expect(res.statusCode).toBe(200);
    // Cognito's document with exactly three fields changed.
    expect(JSON.parse(res.body ?? "")).toEqual({
      ...COGNITO,
      issuer: "https://test.execute-api.eu-west-1.amazonaws.com",
      authorization_endpoint: "https://test.execute-api.eu-west-1.amazonaws.com/oauth/authorize",
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
  });

  it("redirects /oauth/authorize to Cognito without the resource parameter", async () => {
    const h = withDiscovery(() => Promise.resolve(COGNITO));
    const event = httpEvent("GET", "/oauth/authorize");
    event.rawQueryString =
      "response_type=code&client_id=claude1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
      "&scope=openid+email+profile&state=s1&code_challenge=c1&code_challenge_method=S256" +
      "&resource=https%3A%2F%2Ftest.execute-api.eu-west-1.amazonaws.com%2Fmcp";
    const res = await h(event);
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers?.location));
    expect(`${location.origin}${location.pathname}`).toBe(`${AUTH}/oauth2/authorize`);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: "code",
      client_id: "claude1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "openid email profile",
      state: "s1",
      code_challenge: "c1",
      code_challenge_method: "S256",
    });
  });

  it("answers 502 when Cognito's discovery can't be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = withDiscovery(() => Promise.reject(new Error("timeout")));
    const res = await h(httpEvent("GET", "/.well-known/oauth-authorization-server"));
    expect(res.statusCode).toBe(502);
    errors.mockRestore();
  });
});

describe("cognitoDiscovery", () => {
  it("fetches the issuer's OpenID configuration once an hour", async () => {
    clearDiscoveryCache();
    const fetchFn = vi.fn(() => Promise.resolve(Response.json(COGNITO)));
    await cognitoDiscovery(ISSUER, fetchFn, 0);
    await cognitoDiscovery(ISSUER, fetchFn, 59 * 60 * 1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.anything(),
    );
    await cognitoDiscovery(ISSUER, fetchFn, 61 * 60 * 1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    clearDiscoveryCache();
  });
});
