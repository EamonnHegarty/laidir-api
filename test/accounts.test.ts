import {
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it } from "vitest";
import { CognitoAccounts, type CognitoSender } from "../src/api/accounts.js";

const POOL = "eu-west-1_TEST";

function stub(fail?: (command: unknown) => Error | undefined) {
  const sent: unknown[] = [];
  const client: CognitoSender = {
    send(command) {
      sent.push(command);
      const error = fail?.(command);
      return error ? Promise.reject(error) : Promise.resolve({});
    },
  };
  return { sent, accounts: new CognitoAccounts(client, POOL) };
}

const notFound = () => Object.assign(new Error("gone"), { name: "UserNotFoundException" });

describe("CognitoAccounts", () => {
  it("signs out and deletes the given user in the configured pool", async () => {
    const { sent, accounts } = stub();
    await accounts.signOutEverywhere("user-1");
    await accounts.deleteUser("user-1");
    expect(sent[0]).toBeInstanceOf(AdminUserGlobalSignOutCommand);
    expect(sent[1]).toBeInstanceOf(AdminDeleteUserCommand);
    for (const c of sent as AdminDeleteUserCommand[]) {
      expect(c.input).toEqual({ UserPoolId: POOL, Username: "user-1" });
    }
  });

  it("treats an already-deleted user as done", async () => {
    const { accounts } = stub(notFound);
    await expect(accounts.signOutEverywhere("gone")).resolves.toBeUndefined();
    await expect(accounts.deleteUser("gone")).resolves.toBeUndefined();
  });

  it("surfaces other errors (e.g. missing IAM permission)", async () => {
    const { accounts } = stub(() =>
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    await expect(accounts.deleteUser("u")).rejects.toThrow("denied");
  });
});
