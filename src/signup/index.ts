import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { createSignupHandler, maxUsersFromEnv } from "./check.js";

/** Lambda entry point for laidir-<env>-signup. The rules are in check.ts. */
let client: CognitoIdentityProviderClient | undefined;
const cognito = () => (client ??= new CognitoIdentityProviderClient({}));
// Client names don't change; one lookup per warm container is enough.
const names = new Map<string, string | undefined>();

export const handler = createSignupHandler({
  allowedClientName: process.env.ALLOWED_CLIENT_NAME ?? "",
  maxUsers: maxUsersFromEnv(process.env.MAX_USERS),
  async clientName(userPoolId, clientId) {
    if (!names.has(clientId)) {
      try {
        const out = await cognito().send(
          new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
        );
        names.set(clientId, out.UserPoolClient?.ClientName);
      } catch {
        return undefined;
      }
    }
    return names.get(clientId);
  },
  async countUsers(userPoolId, stopAt) {
    let count = 0;
    let token: string | undefined;
    do {
      // No attributes requested: only the count matters.
      const page = await cognito().send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Limit: 60,
          AttributesToGet: [],
          PaginationToken: token,
        }),
      );
      count += page.Users?.length ?? 0;
      token = page.PaginationToken;
    } while (token && count < stopAt);
    return count;
  },
});
