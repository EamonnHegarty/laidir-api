import {
  AdminDeleteUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

/** The Cognito side of account deletion. Always called with the verified caller's own username. */
export interface Accounts {
  /** Revokes every refresh token the user has (all devices, Claude included). */
  signOutEverywhere(username: string): Promise<void>;
  /** Deletes the Cognito user. Already gone counts as done. */
  deleteUser(username: string): Promise<void>;
}

/** The subset of the Cognito client used here (lets tests stub it). */
export interface CognitoSender {
  send(command: AdminUserGlobalSignOutCommand | AdminDeleteUserCommand): Promise<unknown>;
}

const isUserNotFound = (err: unknown) =>
  (err as { name?: unknown } | null)?.name === "UserNotFoundException";

export class CognitoAccounts implements Accounts {
  constructor(
    private readonly client: CognitoSender,
    private readonly userPoolId: string,
  ) {}

  async signOutEverywhere(username: string): Promise<void> {
    try {
      await this.client.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
    } catch (err) {
      if (!isUserNotFound(err)) throw err;
    }
  }

  async deleteUser(username: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      );
    } catch (err) {
      if (!isUserNotFound(err)) throw err;
    }
  }
}

export const createCognitoClient = () => new CognitoIdentityProviderClient({});
