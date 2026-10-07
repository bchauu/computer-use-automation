# Foundation setup

## Scope

The project includes two React/Vite applications and two Express entry points, MongoDB-backed operator history, local evidence fallback, and verification scripts. The completed vertical slice adds a managed Playwright session, OpenAI discovery, strict action and policy validation, runtime classification, diagnostics, bounded recovery, safe local/Mongo telemetry, deterministic artifact compilation, capability dispatch, model-free replay, and same-session human control transfer.

One root npm package keeps installation simple. `apps/operator` and `apps/bank` have independent Vite configurations. `src/automation` and `src/bank` start separate services; `src/shared` contains generic health and lifecycle wiring. No automated route can read bank data.

The automation backend separates HTTP routing from request logic. `src/automation/server.ts` mounts the session, run, and operator routers from `routes/`; the run router mounts a handoff router that preserves the parent `runId` parameter. Named handlers in `handlers/` perform request validation, authorization, dispatch, and response mapping. `services.ts` constructs the shared session registry, model client, catalog, and execution controllers, while `authorization.ts` contains token checks. The discovery and replay engines remain in `src/discovery/`.

## Current installation status

The setup machine has Node 22.22.0, npm 10.9.4, and MongoDB Community 7.0.16. Dependencies have now been installed and `package-lock.json` generated. `npm ls --depth=0` confirms all declared packages are present. The Playwright Chromium executable is also present.

Verified on 2026-09-30: strict TypeScript checking, 29 automated tests, server compilation, production builds, Chromium-driven discovery/replay integration, runtime-condition matrix, both HTTP handoff paths, and the complete banking walkthrough. GPT-4o mini completed a genuine three-action discovery; separate processes replayed the persisted artifact with different inputs and members with zero model calls. The reviewed evidence verifier validates schemas, provenance, hashes, and sensitive-value scans.

Use `npm ci` for reproducible installs from the lockfile. No model calls were made during these checks.

## Database setup

Copy `.env.example` to `.env` if it does not exist. `npm run db:local` starts an isolated MongoDB process on loopback port 27018 with project-local data under `.local/mongo`. Stop it with Ctrl+C. It does not use or alter another project's database. Only `AUTOMATION_MONGODB_URI` is required for persisted runs and capabilities; the synthetic bank UI uses bundled fixtures.

Alternatively, point `AUTOMATION_MONGODB_URI` at a dedicated database in a hosted cluster. Reusing a development cluster is acceptable, but use a separate database name and preferably an application-scoped user. `npm run db:check` pings it without writing data and suppresses connection details on errors. `npm run persistence:system` then creates uniquely identified synthetic run and artifact records, reconnects and validates them plus the required indexes, and deletes only those temporary records.

Set `OPERATOR_ACCESS_TOKEN` to a long random value to enable persisted history in the operator console. The protected endpoints require it as `x-operator-token`; the local console keeps it in `sessionStorage`. It is not a production identity system.

The local standalone server is sufficient for the initial read-only target and foundation checks. It does not support multi-document transactions; introduce a replica set if the accepted persistence design requires them. Do not weaken consistency requirements merely to preserve the local topology.

## OpenAI

The server uses the Responses API with strict Structured Outputs. `OPENAI_MODEL` defaults to `gpt-4o-mini` and remains configurable. Configure `OPENAI_API_KEY` only for an authorized live discovery run. Never expose secrets through Vite-prefixed variables. The retained genuine run used three model calls, 3,636 input tokens, and 164 output tokens; its evidence contains no copy of the configured key.

For an explicitly injected local wiring check, set `DISCOVERY_MODEL_MODE=mock` or run `npm run mock:system` while the banking UI is running. The mock provider uses the same discovery controller and strict action contract, but its choices are scripted and must never be described as genuine LLM discovery evidence. If `AUTOMATION_MONGODB_URI` is reachable, `mock:system` uses an isolated temporary database and removes it afterward; otherwise, it exercises the local-file fallback. It leaves reviewable local run evidence under `.local/runs/`.

The first-run defaults allow 40 actions, ten minutes overall, two minutes per model request, 30 seconds per UI action, three transient model attempts, and three repeated identical state/action decisions. All are configurable in `.env`. Authentication/configuration errors stop; transient rate-limit, timeout, connection, and 5xx failures retry with bounded exponential delay. A failed UI click is recorded as an unknown-effect result and is not blindly repeated.

The model-request block is separated into `src/discovery/model-request.ts`: provider calls, the existing retry classification (HTTP 408/409/429, 5xx, and `ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`), exponential backoff, request telemetry, and shared per-run call/token accounting. `controller.ts` retains UI observation, ownership/action checks, execution, and completion. `src/shared/deadline.ts` supplies clock bookkeeping for the existing deadline checks; it does not cancel operations or add deadline enforcement at new points. This structural refactor leaves the prompt and retry behavior unchanged. The separately identified late-response timeout gap remains a follow-up fix.

## Verification commands

- `npm run typecheck`: strict TypeScript checks across services and UIs.
- `npm test`: all Node and Chromium integration tests. Restricted environments must permit loopback servers and browser launch.
- `node --experimental-strip-types --test tests/discovery-policy.test.ts`: synthetic live-DOM regressions for form submission, external/undeclared destinations, changed links, downloads, new browser surfaces, and known-notice recovery. Includes injected model choices through the discovery controller; no OpenAI calls.
- `npm run test:discovery`: goal/action contracts, artifact compilation/catalog behavior, and Chromium-driven dispatcher/replay tests without a model call.
- `npm run test:bank-ui`: full employee lookup, verification, account, history, empty-state, and route-isolation walkthrough; start `npm run dev:bank` first.
- `npm run mock:system`: injected discovery → draft compilation → different-input model-free validation replay against the running real banking UI.
- `npm run replay:bootstrap`: install the checked-in validated example into an empty local capability catalog; preserve an existing entry. Run before `npm run replay:catalog` on a fresh clone. Neither command requires OpenAI; use `OPENAI_API_KEY='' AUTOMATION_MONGODB_URI='' npm run replay:catalog` for a model-free, database-free walkthrough with `npm run dev:bank` running.
- `npm run live:system`: genuine OpenAI discovery → draft compilation → different-period model-free validation replay against the running real banking UI. The script limits discovery to six model calls and a 15,000-token stop threshold checked after each response (not a prepaid token ceiling).
- `npm run handoff:system`: injected employee-session expiry → same-session human relay → checkpointed model-free resume.
- `npm run handoff:decision`: injected unknown dialog → explicit human judgment → stale/wrong command rejection → checkpointed model-free resume.
- `npm run stability:system`: repeated model-free replay across periods, members, pagination, and business outcomes; writes an ignored local aggregate under `.local/stability/`.
- `npm run evidence:export`: reconstruct and scan the reviewed evidence bundle from retained local runs.
- `npm run evidence:verify`: independently parse the checked-in bundle, verify every hash, prove model-free provenance, and scan for sensitive patterns.
- `npm run demo:record`: record a silent product walkthrough using deterministic replay and the unknown-dialog handoff; requires MongoDB and the operator token.
- `npm run persistence:system`: MongoDB write, reconnect, read, schema/index verification, and targeted cleanup using synthetic records.
- `npm run build`: type-check, compile services, and build both React apps.
- `npm run db:check`: read-only database connectivity check.
- `npm run browser:check`: launch Chromium and click a local in-memory test page. It is a tooling smoke check, not discovery evidence.

Health routes are development diagnostics only. These services bind to loopback and do not yet provide production authentication or durable browser-session recovery.
