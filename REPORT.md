# Architecture

The implementation demonstrates one bounded capability against Northline, a synthetic employee banking interface: show the currently verified member’s checking or savings transaction history for the latest entry or the last 7, 14, or 30 days. A React target provides controlled runtime conditions; Node/Express owns Playwright browser sessions; OpenAI drives discovery; a compiler converts executed evidence into a capability; and a separate interpreter performs replay without a model transport.

Discovery observes a compact inventory of visible controls, headings, route, and bounded text. GPT-4o mini returns one schema-constrained action at a time. Ordinary code validates the observation revision, target, action shape, policy, ownership epoch, budgets, and independently measured completion. Executed actions and observations—not a model-authored step list—feed compilation.

Replay resolves a catalog artifact and executes its parameterized steps directly. Both paths use the same session ownership model, origin boundary, runtime-state vocabulary, safe telemetry, and policy concepts. MongoDB is optional: local schema-validated files make the demonstrated slice runnable without database infrastructure. An explicit bootstrap command installs the reviewed example capability for fresh-clone model-free replay while preserving existing catalog entries.

# Artifact schema

The JSON artifact is typed, serializable, versioned, and reviewable. It declares the capability effect, browser/top-frame surface, typed inputs and UI mappings, verified-member preconditions, ordered actions, exact target strategies, expected action effects, retry permissions, postconditions, stable route/heading/value checkpoints, bounded extraction pagination, completion predicates, budgets, and discovery provenance.

Targets use exact accessible roles or labels. Account selection scopes the history link to exactly one row containing the requested account type. Missing or multiple targets never fall back to the first match. Member and account IDs are runtime bindings; sensitive example values are not stored as artifact inputs. A draft is promoted only after a different-input model-free replay succeeds, and the catalog does not replace a validated artifact with a later draft.

# Determinism & error handling

Replay makes no model calls and does not require an OpenAI key. Each step observes, resolves exactly one target, constructs an action intent, evaluates policy, checks ownership, executes once, rechecks its execution lease, classifies the resulting UI, and verifies the declared checkpoint. An action that throws after dispatch is `attempted_effect_unknown` and is not blindly repeated.

Runtime conditions distinguish business outcomes, bounded recovery, intervention, hard failure, cancellation, and session loss. An absent requested account and an empty transaction period are business outcomes. A loading screen causes bounded re-observation without repeating the navigation click. A recognized maintenance notice uses a separately authored, recorded recovery. Session expiry and unknown dialogs create resumable same-session handoffs; the former permits only the declared credential controls, while the latter requires an explicit proceed-or-cancel judgment. Permission failures remain terminal interventions. Application errors, missing/ambiguous targets, forbidden destinations, and unsupported states stop explicitly.

Final extraction follows the artifact's exact `Next`-button declaration within the verified history route. Each page advance passes policy, records telemetry, must add new transaction references, and is bounded by the artifact. Repeated states, duplicate references, ambiguous pagination, and page-limit exhaustion fail with specific diagnostics instead of returning a plausible but incomplete result. Monetary outputs preserve the rendered value and derive direction, `USD`, and exact integer minor units with a versioned parser; malformed or conflicting debit/credit cells fail schema validation.

Failure diagnostics include phase, artifact step, action-effect state, expected route/headings/target count, sanitized observed route/headings/state hash, recovery decision, and an evidence reference. Discovery rejects decisions returned after its run deadline and retains original DOM indices when hidden controls are omitted from observations. Tests cover model budgets, late decisions, hidden-control indexing, stale model observations, ambiguity, policy denial, slow rendering, known and unknown dialogs, application failure, account absence, cancellation boundaries, and lost-session classification.

# Heterogeneity & multi-tenant

The demonstrated adapter is browser/DOM-based and explicitly declares top-frame scope. The abstraction separates a business capability from a product-version target profile and a tenant binding. A future tenant binding would supply base origin, locale, route mapping, and approved label variations while only narrowing policy. A product-version change that breaks targets or checkpoints would quarantine the binding for validation or rediscovery; it would not silently mutate the live capability.

Native desktop, visual anchors, cross-frame targets, hostile tenant isolation, durable workers, and broad vendor normalization are design extensions. They require implemented adapters and tests before being claimed. Browser contexts provide adequate demo isolation, not a production multi-tenant security boundary.

# Escalation & handoff

Synthetic employee-session expiry and an unknown security dialog demonstrate real pause, cede, and resume. Replay detects the blocked state after navigation, preserves the same Playwright page and browser context, and exposes an intervention. A control-token-protected endpoint grants one human owner and increments the ownership epoch. The relay permits only the controls declared for that intervention: the synthetic PIN field plus re-authentication button, or the explicit proceed button. It records the credential fill without its value.

Resume is rejected until the blocked artifact checkpoint is restored. Successful resume increments the epoch again and returns control to deterministic replay. A second claim, stale human command, wrong intervention command, premature resume, late post-resume command, and cancellation after completion are rejected in integration checks. Human actions remain run evidence and do not alter the reusable capability.

# Safety

The target uses only fictional data and has no banking API or mutation implementation. Discovery and replay share a live-target read-only policy: navigation requires a non-form link to an allowed same-origin route; form-associated controls, downloads, new-window links, and unknown button effects are denied. Discovery also constrains model actions, validates observation revisions, and blocks effectful labels. Known-notice dismissal is an explicit recovery rule requiring its declared dialog and non-form button. UI and model text cannot widen policy. These DOM checks cover the reviewed synthetic application; they do not infer arbitrary JavaScript handler effects.

Persisted evidence contains bounded structural observations rather than raw HTML. Password values are excluded at observation time; event purposes are sanitized at the shared writer before memory, file, and MongoDB storage; diagnostics are bounded and sanitized; unrestricted errors are not dumped. Redaction covers configured API/operator secrets, key and credential-URI patterns, emails, and long numeric values; this remains a bounded synthetic-data safeguard, not universal detection of arbitrary sensitive text. The evidence exporter reparses selected files through their schemas, verifies zero model requests in replay, labels genuine/injected provenance, excludes screenshots, scans for the configured API key and synthetic PIN canary, and hashes exported files.

# Cuts

The implementation supports one read-only browser capability. It does not claim arbitrary natural-language task coverage, production authentication, exactly-once UI writes, native desktop support, general visual automation, production RBAC, encrypted evidence storage, durable queues, high availability, or real multi-tenant isolation. The natural-language dispatcher intentionally recognizes the supported account-history contract; an upstream agent-facing catalog is optional rather than necessary to prove discovery and replay.

The refreshed genuine run used GPT-4o mini for three model-directed UI actions after the finishing fixes (3,636 input and 162 output tokens). Reviewed evidence includes that run, different-input validation replay, cross-member replay, a complete multi-page replay, and both same-session handoff paths. A protected operator inspector reads persisted history, compares discovery with replay, and exposes timelines, diagnostics, and the executed artifact. A 20-run model-free stability study varied members, account types, periods, pagination, missing accounts, and empty histories; every run produced its expected result, each repeated scenario produced a consistent output hash, and the aggregate contained zero model requests. This bounded local study supports repeatability for the demonstrated fixture, not a production reliability claim.
