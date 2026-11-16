// Signs in through Cognito managed login (authorization code + PKCE) with the devtools app client
// and writes a short-lived access token for the Bruno collection.
//
//   pnpm auth:token           # writes bruno/.env (gitignored)
//   pnpm -s auth:token --print # prints the token instead (for curl)
//
// The client ID is public: `terraform -chdir=envs/prod output -raw devtools_client_id` in laidir-infra.
// The access token lasts 60 minutes; run this again when it expires. Nothing else is stored.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { URL, URLSearchParams } from "node:url";

const AUTH_DOMAIN =
  process.env.LAIDIR_AUTH_DOMAIN ?? "https://laidir-prod-4d9359.auth.eu-west-1.amazoncognito.com";
// Public client ID (laidir-infra output devtools_client_id); override for another environment.
const CLIENT_ID = process.env.LAIDIR_DEVTOOLS_CLIENT_ID ?? "4s584176r7qm7fnvacqa54p40e";
// Must match the devtools client's callback URL in laidir-infra exactly.
const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const PRINT = process.argv.includes("--print");
const ENV_FILE = new URL("../bruno/.env", import.meta.url);

if (!CLIENT_ID) {
  console.error(
    "Set LAIDIR_DEVTOOLS_CLIENT_ID (laidir-infra: terraform -chdir=envs/prod output -raw devtools_client_id).",
  );
  process.exit(1);
}

const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const authorizeUrl = `${AUTH_DOMAIN}/oauth2/authorize?${new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: "openid email profile",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
})}`;

async function exchange(code) {
  const res = await fetch(`${AUTH_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${body.error ?? "unknown error"}`);
  return body;
}

// Listen on loopback only (IPv4 and IPv6, since "localhost" may resolve to either).
const servers = [];
const done = (code) => {
  for (const s of servers) s.close();
  process.exit(code);
};

const onRequest = async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const finish = (status, message) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
  };
  if (url.searchParams.get("state") !== state) {
    finish(400, "State mismatch. Close this tab and run pnpm auth:token again.");
    console.error("State mismatch; ignoring the callback.");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    finish(400, `Sign-in failed: ${url.searchParams.get("error") ?? "no code"}`);
    console.error(`Sign-in failed: ${url.searchParams.get("error_description") ?? "no code"}`);
    done(1);
    return;
  }
  try {
    const tokens = await exchange(code);
    finish(200, "Signed in. You can close this tab.");
    if (PRINT) {
      process.stdout.write(`${tokens.access_token}\n`);
    } else {
      writeFileSync(ENV_FILE, `ACCESS_TOKEN=${tokens.access_token}\n`, { mode: 0o600 });
      const mins = Math.round(tokens.expires_in / 60);
      console.error(`Access token written to bruno/.env (expires in ${mins} min).`);
    }
    done(0);
  } catch (err) {
    finish(500, "Token exchange failed; see the terminal.");
    console.error(err instanceof Error ? err.message : err);
    done(1);
  }
};

for (const host of ["127.0.0.1", "::1"]) {
  const server = createServer((req, res) => void onRequest(req, res));
  server.on("error", (err) => {
    // No IPv6 loopback is fine; a port clash on IPv4 is not.
    if (host === "::1") return;
    console.error(`Can't listen on ${host}:${PORT}: ${err.message}`);
    done(1);
  });
  server.listen(PORT, host);
  servers.push(server);
}

console.error(`Open this URL to sign in (waiting on ${REDIRECT_URI}):\n\n${authorizeUrl}\n`);
setTimeout(() => {
  console.error("Timed out after 5 minutes.");
  done(1);
}, 300_000).unref();
