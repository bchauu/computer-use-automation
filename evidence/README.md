# Reviewed evidence

This bundle contains schema-validated, sanitized proof selected from local runs. Discovery, its different-input validation replay, and the validated capability were refreshed from the authorized 2026-10-07 UTC run after the finishing fixes. Other examples retain their original dates and provenance; the manifest records each run explicitly. [`manifest.json`](manifest.json) records provenance and SHA-256 hashes for every exported file.

| Run | Provenance | Expected result | What it proves |
|---|---|---|---|
| [Discovery](runs/discovery-live/run.json) | Genuine OpenAI | `DISCOVERY_SUCCEEDED` | GPT-4o mini operated the live React UI and produced executed action evidence |
| [Validation replay](runs/validation-replay/run.json) | Live model-free | `REPLAY_SUCCEEDED` | Different period, zero model requests, draft promotion |
| [Cross-member replay](runs/cross-member-replay/run.json) | Live model-free | `REPLAY_SUCCEEDED` | Persisted capability reused for a different verified member |
| [Full pagination](runs/full-pagination-replay/run.json) | Live model-free | `REPLAY_SUCCEEDED` | All 14 matching transactions extracted across pages |
| [Session expiry](runs/session-expiry-handoff/run.json) | Injected condition | `REPLAY_SUCCEEDED` | Same-session credential handoff and verified resume |
| [Unknown dialog](runs/unknown-dialog-handoff/run.json) | Injected condition | `REPLAY_SUCCEEDED` | Human judgment, denied command, stale epoch, and verified resume |
| [Slow loading](runs/slow-load-recovery/run.json) | Injected condition | `REPLAY_SUCCEEDED` | Bounded re-observation without repeating the navigation click |
| [Known notice](runs/known-notice-recovery/run.json) | Injected condition | `REPLAY_SUCCEEDED` | Separately authored and recorded safe recovery |
| [Permission denied](runs/permission-intervention/run.json) | Injected condition | `PERMISSION_DENIED` | Terminal intervention classification |
| [Application failure](runs/application-failure/run.json) | Injected condition | `APPLICATION_ERROR` | Sanitized phase and effect-state diagnostic |
| [Missing account](runs/account-not-found/run.json) | Synthetic outcome | `ACCOUNT_NOT_FOUND` | Expected business result, not a technical failure |
| [Empty history](runs/no-transactions/run.json) | Synthetic outcome | `NO_TRANSACTIONS` | Verified empty result, not a technical failure |

The bundle also includes the validated [`view-transaction-history` capability](capability.json) and a [20-run stability study](stability-summary.json). Every stability run produced its expected result, repeated scenarios had consistent output hashes, and the aggregate contains zero model requests.

Provenance labels mean:

- `genuine_openai`: a paid model made the discovery decisions.
- `live_model_free_replay`: the deterministic interpreter operated the live UI without a model transport.
- `injected_runtime_condition`: the React target deliberately produced a deterministic failure or interruption.
- `synthetic_business_outcome`: fictional fixture data produced a legitimate domain result.

Run `npm run evidence:verify` to reparse all records, check every manifest hash, confirm replay has no model events, and scan for raw HTML, API-key patterns, credential-bearing MongoDB URIs, and the synthetic PIN canary. Run `npm run evidence:export` to reconstruct the bundle from retained local run IDs. Exported examples use fictional Northline data and contain no real banking connection or customer information.
