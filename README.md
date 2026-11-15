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

Entities: `Profile`, `Exercise` (custom), `Routine`, `Workout` (sets embedded). All carry `id` (client UUID),
`type`, `schema_version`, `created_at`, `updated_at` and `deleted_at` (soft delete). Weights are kilograms.
Built-in exercises are referenced as `builtin:<slug>`.

Changing the contract: edit `openapi/` or `schemas/`, run `pnpm gen`, commit the generated files.
CI fails if they're stale. Breaking entity changes need a new `schema_version` and `schemas/v2/`.

## Layout

```
src/api/      REST Lambda (laidir-<env>-api): GET /health, /v1/* (phase 3)
src/mcp/      MCP Lambda (laidir-<env>-mcp): /mcp, /.well-known/oauth-protected-resource (phase 4)
src/shared/   HTTP helpers (RFC 9457 problems), build info
scripts/      esbuild bundling
test/         Vitest: handlers + schema fixtures
```

## Development

Node 24 and pnpm 12.

```bash
pnpm install
pnpm check     # format, lint, spec lint, typecheck, test, build
pnpm gen       # re-bundle the spec and regenerate types
pnpm build     # dist/api/index.mjs, dist/mcp/index.mjs
```

## CI/CD

```
PR ─► checks: format · lint · spec lint · generated files fresh · typecheck · test · build
merge to main ─► deploy (GitHub Environment "prod", OIDC role laidir-gha-api-deploy-prod)
                 build → update-function-code (api, mcp) → wait → smoke test /health + /mcp
```

- The deploy role can only update code on the two functions. Terraform owns their configuration.
- The smoke test checks the `x-laidir-version` header equals the merged commit, so it proves the new code is live.
- Actions are pinned to full commit SHAs; Dependabot keeps them and npm packages current, with a cooldown.
- Rollback: revert the PR; the deploy runs again.
