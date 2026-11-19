import type { PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSignupHandler,
  FULL,
  maxUsersFromEnv,
  NOT_FROM_APP,
  type SignupDeps,
} from "../src/signup/check.js";

const POOL = "eu-west-1_test";
const CLIENTS: Record<string, string> = {
  app: "laidir-prod-mobile",
  claude: "laidir-prod-claude",
  devtools: "laidir-prod-devtools",
};

function event(
  triggerSource: PreSignUpTriggerEvent["triggerSource"],
  clientId: string | null = "app",
): PreSignUpTriggerEvent {
  return {
    version: "1",
    region: "eu-west-1",
    userPoolId: POOL,
    userName: "00000000-0000-4000-8000-000000000000",
    triggerSource,
    callerContext: { awsSdkVersion: "1", clientId: clientId ?? "" },
    request: { userAttributes: { email: "someone@example.com" } },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  };
}

describe("pre sign-up check", () => {
  let users: number;
  let deps: SignupDeps;

  beforeEach(() => {
    users = 3;
    vi.spyOn(console, "log").mockImplementation(() => {
      /* quiet */
    });
    deps = {
      allowedClientName: "laidir-prod-mobile",
      maxUsers: 30,
      clientName: vi.fn((_pool: string, id: string) => Promise.resolve(CLIENTS[id])),
      countUsers: vi.fn(() => Promise.resolve(users)),
    };
  });

  it("lets someone sign up from the app while there's room", async () => {
    const e = event("PreSignUp_SignUp");
    await expect(createSignupHandler(deps)(e)).resolves.toBe(e);
    expect(deps.countUsers).toHaveBeenCalledWith(POOL, 30);
  });

  it("does not auto-confirm: the email code is still needed", async () => {
    const out = await createSignupHandler(deps)(event("PreSignUp_SignUp"));
    expect(out.response.autoConfirmUser).toBe(false);
    expect(out.response.autoVerifyEmail).toBe(false);
  });

  it.each(["claude", "devtools", "someone-elses-client"])(
    "refuses sign-up from the %s client",
    async (id) => {
      await expect(createSignupHandler(deps)(event("PreSignUp_SignUp", id))).rejects.toThrow(
        NOT_FROM_APP,
      );
      expect(deps.countUsers).not.toHaveBeenCalled();
    },
  );

  it("refuses when the client is missing", async () => {
    await expect(createSignupHandler(deps)(event("PreSignUp_SignUp", null))).rejects.toThrow(
      NOT_FROM_APP,
    );
  });

  it("refuses once the pool is full", async () => {
    users = 30;
    await expect(createSignupHandler(deps)(event("PreSignUp_SignUp"))).rejects.toThrow(FULL);
  });

  it("allows the last place", async () => {
    users = 29;
    await expect(createSignupHandler(deps)(event("PreSignUp_SignUp"))).resolves.toBeDefined();
  });

  it("always allows invites, even when full", async () => {
    users = 99;
    const e = event("PreSignUp_AdminCreateUser", null);
    await expect(createSignupHandler(deps)(e)).resolves.toBe(e);
    expect(deps.countUsers).not.toHaveBeenCalled();
  });

  it("refuses sign-in from another identity provider", async () => {
    await expect(createSignupHandler(deps)(event("PreSignUp_ExternalProvider"))).rejects.toThrow(
      NOT_FROM_APP,
    );
  });

  it("never logs the email", async () => {
    await createSignupHandler(deps)(event("PreSignUp_SignUp"));
    const logged = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logged).not.toContain("someone@example.com");
    expect(logged).toContain('"allowed":true');
  });
});

describe("maxUsersFromEnv", () => {
  it("reads a whole number", () => {
    expect(maxUsersFromEnv("30")).toBe(30);
  });
  it.each([undefined, "", "0", "-1", "2.5", "lots"])("rejects %s", (v) => {
    expect(() => maxUsersFromEnv(v)).toThrow();
  });
});
