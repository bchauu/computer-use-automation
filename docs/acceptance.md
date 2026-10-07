# Acceptance traceability

Verified locally on 2026-09-30. “Injected” means a deterministic condition in the synthetic React target; it is never presented as genuine model behavior.

Finishing checks on 2026-10-06: `npm run check` passed 54 tests, typechecking, and both application builds. A clean source copy without `.env` or `.local` state (reusing installed dependencies and the running synthetic bank) successfully bootstrapped the reviewed artifact and replayed for Jordan Lee with MongoDB disabled and zero model requests. Injected discovery compiled three executed actions; different-period validation replay returned eight transactions without model calls. All seven runtime system scenarios passed. Session-expiry takeover retained the same page/context, rejected a stale command, resumed successfully, and did not persist the synthetic PIN. The reviewed evidence bundle passed schema/hash verification again (12 runs, 28 files, 20 stability runs).

Regression checks cover purpose-text canaries at the memory/file/Mongo-write boundary (Mongo writes mocked), late model responses executing no action, expired retries, hidden-control indexing, target drift, and bootstrap preservation of existing catalog versions. A subsequent authorized genuine GPT-4o mini discovery (2026-10-07 UTC) verified the finishing changes: three model calls, 3,636 input tokens, and 162 output tokens, within the six-call / 15,000-token stop budget. Different-period model-free validation replay returned eight transactions and promoted the new artifact. The reviewed discovery, validation replay, and capability were refreshed and the full bundle passed export/privacy/hash verification. Other runtime, cross-member, handoff, and stability examples retain their original run dates and provenance.

| Requirement | Implementation | Verification/evidence |
|---|---|---|
| R1 Goal and entry point | Managed session plus natural-language run request | Dispatcher and API integration tests |
| R2 Genuine live discovery | OpenAI one-action observe/decide/act loop | `evidence/runs/discovery-live` |
| R3 Bounded execution | Step, time, repeated-state, model-call, token, action, recovery, and handoff bounds | Discovery tests and runtime matrix |
| R4 Typed versioned artifact | Strict Zod artifact separate from transcript | `evidence/capability.json`; compiler tests |
| R5 Actions and robust targets | Ordered actions, exact role/label strategies, cardinality, top-frame scope, effect declarations | Capability and ambiguity tests |
| R6 Typed I/O and success | Parameter bindings, bounded pagination, extraction contract, checkpoints, independent completion | Validation, cross-member, and full-pagination replay evidence |
| R7 Model-free replay | Replay controller imports no model transport | Replay evidence and the 20-run stability study have zero model-request events |
| R8 Runtime conditions | Business outcomes, loading, known/unknown dialogs, permission, app error, expiry, ambiguity | Runtime integration test, both handoff system runs, and exported scenarios |
| R9 Outcome taxonomy | Success, business outcome, intervention, hard failure, cancellation | Public run schema and scenario assertions |
| R10 Failure diagnostics | Phase, step, effect state, expectations, sanitized observation, recovery decision, evidence ref | Application-failure evidence |
| R11 Policy | Origin, route, surface, target semantics, expected effect, destination, discovery restrictions | Forbidden-destination and effectful-target tests |
| R12 Sensitive data | Password omission, bounded sanitization, no raw HTML, reviewed export scan | Evidence manifest review fields and canary tests |
| R13 Structured logs/evidence | JSONL event timeline, state hashes, action evidence, diagnostics, repeatability aggregate | Reviewed evidence bundle and `stability-summary.json` |
| R14 Intervention context | Typed intervention result with step diagnostic and current structural state | Permission and expiry evidence |
| R15 Same-session human control | Original page/context retained; sanitized credential and judgment actions; checkpoint revalidation | Session-expiry and unknown-dialog system runs plus API tests |
| R16 Pause/cede/resume ownership | Exclusive owner, epoch fencing, stale/late/wrong command rejection | Both HTTP handoff paths |
| R17 Surface/tenant reuse design | Browser adapter scope, product profile and tenant-binding design, drift rejection | `REPORT.md` and implementation plan |

## Final local commands

Additional clean-catalog verification: the user authorized deleting saved capabilities only. One local catalog file and three database capability records were removed after validating their assessment schema and synthetic discovery-source provenance; run history and the reviewed submission bundle were preserved. A new GPT-4o mini discovery then succeeded in three calls (3,636 input and 177 output tokens), followed by an eight-transaction different-period replay with zero model calls. Post-run checks found exactly one new validated capability in MongoDB and one matching local file. The clean run is retained under `.local/runs/c85ecfd8-c7f7-4e32-b3dc-f4d35f5f528a`; its validation replay is `4cc50fbc-4308-4735-8892-432bd7c6c697`. The checked-in bundle retains the preceding successful paid run and still passes verification.

```sh
npm ci
npm run browser:install
npm run check
```

With `npm run dev:bank` running in another terminal:

```sh
npm run test:bank-ui
npm run replay:bootstrap
npm run replay:catalog
npm run runtime:system
npm run handoff:system
npm run handoff:decision
npm run evidence:export
npm run evidence:verify
```

`npm run live:system` performs a new paid discovery and requires `OPENAI_API_KEY`. Existing reviewed discovery evidence is included, so ordinary replay and automated verification require neither an API key nor MongoDB.
