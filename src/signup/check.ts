import type { PreSignUpTriggerEvent } from "aws-lambda";

/**
 * Cognito pre sign-up trigger (laidir-<env>-signup). Self sign-up is open, but only:
 *   - from the app's sign-in client (not Claude's connector or the devtools client), and
 *   - while the pool has fewer than MAX_USERS accounts (confirmed or not).
 * Invites made with AdminCreateUser are always allowed.
 *
 * Throwing rejects the sign-up; Cognito shows the message on its sign-up page.
 * The client is identified by its name, read at runtime, because passing its ID in would make
 * a Terraform cycle (the pool needs this function's ARN; the client needs the pool).
 */
export interface SignupDeps {
  /** App client name allowed to sign people up, e.g. laidir-prod-mobile. */
  allowedClientName: string;
  maxUsers: number;
  clientName: (userPoolId: string, clientId: string) => Promise<string | undefined>;
  /** Number of users in the pool, counting at most up to `stopAt`. */
  countUsers: (userPoolId: string, stopAt: number) => Promise<number>;
}

export const NOT_FROM_APP = "Create your Láidir account in the Láidir app.";
export const FULL = "Láidir is full for now, so new accounts are paused.";

export function createSignupHandler(deps: SignupDeps) {
  return async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
    const log = (allowed: boolean, reason: string, extra: Record<string, unknown> = {}) => {
      // No email or other user attributes in logs.
      console.log(
        JSON.stringify({
          level: "info",
          msg: "pre sign-up",
          trigger: event.triggerSource,
          allowed,
          reason,
          ...extra,
        }),
      );
    };

    if (event.triggerSource === "PreSignUp_AdminCreateUser") {
      log(true, "invite");
      return event;
    }
    if (event.triggerSource !== "PreSignUp_SignUp") {
      log(false, "unsupported trigger");
      throw new Error(NOT_FROM_APP);
    }

    const clientId = event.callerContext.clientId;
    const name = clientId ? await deps.clientName(event.userPoolId, clientId) : undefined;
    if (name !== deps.allowedClientName) {
      log(false, "wrong client", { client: name ?? "unknown" });
      throw new Error(NOT_FROM_APP);
    }

    const users = await deps.countUsers(event.userPoolId, deps.maxUsers);
    if (users >= deps.maxUsers) {
      log(false, "full", { users, max: deps.maxUsers });
      throw new Error(FULL);
    }

    log(true, "app sign-up", { users, max: deps.maxUsers });
    return event;
  };
}

export function maxUsersFromEnv(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error("MAX_USERS must be a whole number above 0");
  return n;
}
