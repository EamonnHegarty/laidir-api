# laidir-api

REST API and MCP server for **Láidir**, a local-first gym tracker.
TypeScript on AWS Lambda (arm64, `nodejs24.x`), deployed by GitHub Actions via OIDC.

Infrastructure lives in [laidir-infra](https://github.com/EamonnHegarty/laidir-infra).
This repo owns the Lambda **code** and the **API contract**.

## Contract

| Path                                                           | What                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`openapi/openapi.yaml`](openapi/openapi.yaml)                 | **Source of truth.** OpenAPI 3.1                                             |
| [`openapi/openapi.bundled.json`](openapi/openapi.bundled.json) | Single-file bundle (generated). laidir-mobile generates its client from this |
| [`schemas/v1/`](schemas/v1)                                    | Versioned entity schemas (JSON Schema 2020-12), shared by REST and MCP       |
| [`src/generated/openapi.ts`](src/generated/openapi.ts)         | TypeScript types (generated)                                                 |
| [`catalogue/v1/exercises.json`](catalogue/v1/exercises.json)   | Built-in exercise catalogue (static, versioned). See [catalogue/](catalogue) |

Entities: `Profile`, `Exercise` (custom), `RoutineFolder`, `Routine`, `Workout` (sets embedded). All carry `id`
(client UUID), `type`, `schema_version`, `created_at`, `updated_at` and `deleted_at` (soft delete). Weights are kilograms.
Built-in exercises are referenced as `builtin:<slug>`; **slugs are permanent** (deprecate, never delete).

Routines can sit in a `RoutineFolder` (`folder_id`); folders and routines are ordered by `sort_order`.
Deleting a folder tombstones it and removes `folder_id` from its routines. Readers treat a `folder_id`
that points to a missing or deleted folder as unfiled.

Changing the contract: edit `openapi/` or `schemas/`, run `pnpm gen`, commit the generated files.
CI fails if they're stale. Breaking entity changes need a new `schema_version` and `schemas/v2/`.

## Layout

## Endpoints

| Route                         | What                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /health`                 | Public liveness + deployed version                                                       |
| `GET /v1/sync?cursor=&limit=` | Changes since an opaque cursor, in server `synced_at` order (writes ≥ 2 s old)           |
| `POST /v1/sync`               | Up to 25 whole items; each `applied`, `stale` (with the server's `current`) or `invalid` |
| `GET /v1/profile`             | The caller's Profile (404 until first pushed)                                            |
| `DELETE /v1/account`          | Signs out everywhere, deletes all the caller's items, then their Cognito user (204)      |

`/v1` sits behind API Gateway's JWT authorizer (mobile and devtools Cognito clients). The handler only runs
`/v1` logic when the route key is `ANY /v1/{proxy+}`, and every read and write is keyed on the token's `sub`.
Writes are conditional on `updated_at` (last writer wins); a retried write reports `applied`.

```
src/api/      REST Lambda (laidir-<env>-api): GET /health, /v1/sync, /v1/profile
src/mcp/      MCP Lambda (laidir-<env>-mcp): /mcp (Claude connector), /.well-known/oauth-protected-resource
src/shared/   HTTP helpers (RFC 9457 problems), build info
scripts/      esbuild bundling
test/         Vitest: handlers + schema fixtures
```

## MCP server (Claude connector)

`/mcp` is a remote MCP server (Streamable HTTP, stateless, built on `@modelcontextprotocol/server` v2). It serves
2026-07-28 clients and, through the SDK's stateless fallback, 2025-era clients that start with `initialize`.

- **Auth:** no gateway authorizer. Without a valid token `/mcp` answers `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`, which starts
  Claude's OAuth flow against Cognito. The Lambda verifies the access token itself (JWKS signature, issuer, expiry,
  `token_use=access`, the Claude client, and `aud` equal to the MCP URL: Claude sends the RFC 8707 `resource`
  parameter and Cognito binds it into `aud`).
- **Metadata:** `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728): `resource` is exactly `<origin>/mcp`
  and `authorization_servers` is our own origin. `GET /.well-known/oauth-authorization-server` (RFC 8414, served by the
  api Lambda on `$default`) is Cognito's discovery document with `issuer` = our origin and
  `token_endpoint_auth_methods_supported: ["none"]`: Cognito lists only secret-based methods, so Claude would otherwise
  send Basic auth with an empty secret, which Cognito rejects (`invalid_client`). All endpoints stay Cognito's.
- **Tools** (every one has a title and annotations), using the same store, schemas and sync feed as `/v1`, scoped to
  the token's `sub`:
  - read-only: `search_exercises`, `list_routines`, `get_routine`, `list_workouts`, `get_workout`,
    `get_exercise_history`
  - writes: `create_routine`, `update_routine`, `delete_routine` (a tombstone), `create_custom_exercise`. Items are
    validated against `schemas/v1` and stamped with the server clock (strictly after the stored `updated_at`, so
    last-writer-wins keeps them); the app picks them up on its next sync.
- **Connecting:** Claude → Settings → Connectors → Add custom connector, URL `<api_endpoint>/mcp`, and under
  advanced settings the `claude_client_id` from laidir-infra (Cognito has no dynamic client registration).

## Development

Node 24 and pnpm 12.

```bash
pnpm install
pnpm check     # format, lint, spec lint, typecheck, test, build
pnpm gen       # re-bundle the spec and regenerate types
pnpm build     # dist/api/index.mjs, dist/mcp/index.mjs
```

### Calling prod with a real token

[`bruno/`](bruno) is a [Bruno](https://www.usebruno.com/) collection for the API. To get a token, sign in through
Cognito with the `laidir-prod-devtools` client (public, PKCE, redirect `http://localhost:8976/callback`):

```bash
# Uses the prod devtools client by default (set LAIDIR_DEVTOOLS_CLIENT_ID to override).
# Prints a sign-in URL: open it in a browser and sign in.
# Then writes bruno/.env (gitignored) with an access token valid for 60 minutes.
# Not `pnpm token`: that's a built-in pnpm command.
pnpm auth:token
curl -H "authorization: Bearer $(pnpm -s auth:token --print)" \
  https://yqyk3qt5b8.execute-api.eu-west-1.amazonaws.com/v1/profile
```

Open the `bruno/` folder in Bruno, choose the `prod` environment, and send requests. Everything under `/v1`
acts only on the signed-in user's own data.

## CI/CD

```
PR ─► checks: format · lint · spec lint · generated files fresh · typecheck · test · build
merge to main ─► deploy (GitHub Environment "prod", OIDC role laidir-gha-api-deploy-prod)
                 build → update-function-code (api, mcp) → wait → smoke test /health, /mcp (401), MCP metadata
```

- The deploy role can only update code on the two functions. Terraform owns their configuration.
- The smoke test checks the `x-laidir-version` header equals the merged commit, so it proves the new code is live.
- Actions are pinned to full commit SHAs; Dependabot keeps them and npm packages current, with a cooldown.
- Rollback: revert the PR; the deploy runs again.
