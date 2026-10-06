# Design

## Context

See proposal.md — Why. The implementation baseline is `doc/multi-agent-implementation-design.md` v0.2, with the unchanged v0.4 conceptual data flows. The starting PostgreSQL schema ended at version 14, runtime authenticated an Agent/placement, and ordinary turns aggregated its inbox. This change covers all P0–P4 as selected by the user.

## Goals / Non-Goals

**Goals:** Establish executable, tested task ownership, associated authorization, isolation, versioned delivery, one-level collaboration, qualified runtime handoff, knowledge publication and migration across P0–P4. Workspaces opt in only after readiness checks; retain legacy behavior for unswitched workspaces.

**Non-Goals (initial implementation):** Production deployment/migration, automatic migration to another device, unbounded recursion, partial-audience group delivery, and a replacement for the full Run/financial lifecycle. Unsupported runtime/tool combinations are explicitly blocked, never treated as satisfying a contract.

## Decisions

1. **Append schema; preserve identities.** Migration 15 introduces normalized task/binding/access/artifact/knowledge records and Workspace mode; 16 adds executor/reference fences, 17 adds source revisions and governance links, 18 adds lifecycle/retention fences, and 19 pins immutable per-Task definition/configuration snapshots. This build supports schemas 14–19, with TASK requiring 19. Existing IDs and historical checksums are retained. Runtime code checks presence/support before applying new behavior so the preparation build remains LEGACY on schema 14. Alternative: replacing existing tables would break references and rollback.
2. **One common service layer.** Add typed Task/Access/Artifact/Knowledge services with injectable Pool clients. Public routes and authenticated runtime operations call the same authorization and transaction functions. Alternative: independent HTTP and inproc policy implementations could disagree.
3. **Task-specific execution, not inbox adaptation.** A separate task loop consumes approved inputs, exposes fixed task tools and records immutable outputs. Models have no runner credentials, old runtime APIs or arbitrary host access. Native tools require verified sandbox/connection adapters; tool discovery does not grant authority. Alternatives: passing taskId to the old turn leaves raw inbox/FUSE/session bypasses.
4. **Durable dispatch and explicit unknown outcomes.** PostgreSQL task dispatches are authoritative; wake is a hint. Only one live claim per Agent. Expired active claims become unknown until the old executor is confirmed stopped. External writes have durable operation keys and do not automatically retry. Alternative: lease expiry as proof of failed work duplicates effects.
5. **Associated grants and live sources.** Grant rules are complete resource/action/identity/target/destination tuples with validated parameter scope. Task grants snapshot an upper bound but source revocation is checked on every protected action. Connections retain credential references outside model context. Alternative: independent unions produce unauthorized combinations.
6. **Versioned delivery and source-aware knowledge.** Store task text/patch/report versions privately and publish after current source/audience checks in the message/outbox transaction. Group inputs require channel shareability before model use; current members must remain compatible. Knowledge preserves sources, pinned only affects ranking, and sharing requires explicit rights.
7. **Domain adapters.** Board and governance references map into task inputs/operations while requiring original grants/mandates/review. Execution complete, Task delivery and card Done remain separate. No automatic card creation for ordinary tasks.
8. **Workspace cutover.** Modes LEGACY/PREPARING/TASK prevent one Agent identity mixing old and protected sessions. In TASK, old APIs/turns are sealed for task executors; all work entry points resolve Channel/Task. Local runner capability claims require verified server admission, per-task session and filtered filesystem/connection access.

## Risks / Trade-offs

- [Broad old API surface] → Enumerate and test scheduler, manual/idle/scanner/poll, HTTP, inproc, CLI, FUSE, memory and local-engine bypasses before enabling TASK.
- [Opaque local engines differ] → Admit only combinations that prove task session, environment, file/process/network and connector isolation; old or unsupported engines return a stable capability error.
- [External resource authority cannot be inferred] → Only supported adapters with verifiable ownership/sharing evidence can issue resource grants. Channel admin does not confer resource ownership.
- [Model tests can hit real services] → Inject deterministic model adapters for behavior tests; record model calls through existing tracked clients and never use live providers in boundary tests.
- [Concurrent publication/revoke/member changes] → Shared locking/CAS and generation checks, with real PostgreSQL race tests.
- [Migrations tighten references] → Additive schema, compatibility preparation build, explicit cleanup and retention ownership; no production data changes in this task.

## Migration Plan

Publish a compatibility preparation build, apply appended schema only in a dedicated test database here, and validate migration checksums. Prepare definitions/bindings, explicit resource policies and runner capabilities in PREPARING. Resolve legacy in-flight/unknown work, activate TASK only after readiness, and preserve old history. Roll back by stopping new dispatch and task capabilities, retaining records, and using only a binary supporting the expanded schema. No destructive down migration or automatic legacy fallback.

## Validation

Map implementation to I01–I12 and A01–A30 of the baseline. Run strict OpenSpec validation, server/frontend typechecks, targeted unit tests, actual isolated PostgreSQL/Redis integration tests and runtime/agent guard scripts. A skipped database suite is not a pass. Record all remaining failures and never mark an unimplemented task complete.

## Concrete runtime and source protocol

`docs/TASK_EXECUTION.zh-CN.md` defines the public/runtime endpoints, preparation and rollback commands, and qualified combinations. The managed worker exposes only artifact creation and one-level planning. The admitted native combination is Linux/Codex/bubblewrap, bound to a reviewed binary hash, isolated PID/network namespaces, empty environment/HOME, read-only approved inputs and fresh execution. Supervisor credentials and provider keys remain outside the model process; only stateless function/custom local tools are admitted. Other engines/connectors fail closed until separately qualified. First-party channel connections use explicit SERVICE/PERSONAL defaults; admin rights do not prove third-party resource ownership.

MESSAGE provenance uses an automatic source version. BOARD provenance snapshots workspace-visible title/description with a canonical content hash and explicit work channel, without pretending board data was authored by the Task creator. Governed cards additionally require original Action/Attempt/Mandate/Primary/budget facts. Artifact and Knowledge sources retain immutable references and recursive current-source checks. No unapproved embedding/cache/raw-memory fallback is used.

Task supplement/steer increments input revision; active contexts with an older revision cannot perform another protected action. Steer commits the input and fresh dispatch together, and execution waits for actual old-process stop. Scope revision additionally retires old objective/grant bounds and old plans, requires explicit reapproval, and never reuses prior delivery as proof of the new scope. Dependencies require both delivered fixed versions and actual handoff inputs before dispatch.

All Task authorization transactions acquire the company task advisory lock before membership/conversation locks. REST message, normalized membership, offboarding and workspace deletion use the same order. Content and Task APIs are private/no-store. Delivery uses current-source checks and the existing message/outbox transaction; source revocation prevents protected history/download/broadcast even when a prior delivery fact remains.

Prospective member addition revalidates live shared inputs and published artifact provenance before committing membership, the join message or its outbox event. Unverifiable/revoked historical authority fails with MEMBERSHIP_SOURCE_AUTHORITY_REQUIRED; no partial-history group is created. Channel-scoped sharing grants cover qualified current members, while unverified workspace membership never extends board/resource authority.

Task detail, sidebar previews, search, replies/quotes and WS delivery share current-source read gates; retained facts do not authorize revoked bodies. Legacy Convene model execution is sealed in PREPARING/TASK, with live sessions included in readiness/rollback stop checks and legacy-mode regression coverage. Existing Convene UI is not an alternate wide task execution path.

Rollback retains Task facts but excludes their linked messages/quotes from legacy wakes, inbox/context, CLI reads/search/glance and Convene grounding. Server-owned Task metadata also fences delayed events after message deletion. Newly authored legacy messages remain eligible for ordinary legacy work. This avoids reinterpreting retained Task input as an authorized legacy retry.

Artifact versions retain 365 days by default, with live inputs/handoffs/deliveries/knowledge/governance references blocking GC. Workspace deletion refuses retained facts and preserves the existing controlled retention procedure. External operation UNKNOWN facts require observed effect and stopped-executor proof, with no automatic replay or device migration.

`scripts/verify-channel-tasks.mjs` runs separate test processes with isolation disabled, verifies actual assertion counts and zero required skips, and retains logs/JSON reports. Native/HTTP/PG/Chrome boundaries are real; model replies and external effects are deterministic adapters so validation does not spend provider funds or mutate external systems.

## Authorized browser repairs and local acceptance (2026-10-04)

The user authorized deployment and browser repairs after initial implementation. Current acceptance excludes cloud service execution and the fourth finding (Agent creation without a selected computer). Keep the existing qualified cloud code and the conceptual data flows unchanged.

Expose an administrator-only configuration projection of definitions, accessible channels, active bindings, Agent placements and reviewed local admissions. Provide shared workspace/channel UI for immutable definition versions, binding edits and atomic default selection, readiness and prepare/activate/stop/rollback. Import actual qualification evidence for local admission; never manufacture passing isolation checks in the UI. Existing Agent settings remain the placement editor.

Use browser-compatible request IDs and SHA-256 on HTTP origins. Verify downloaded content before creating the download, preserve idempotency on retries, hide stale block reasons after cancellation, and keep child tasks out of root selection.

Local Codex receives eligible bindings, root grants, parent identity and whether a plan has already been committed. It may write exactly `/workspace/task-plan.json` to request the same bounded plan contract as `task_plan`; the supervisor reads a regular bounded file after process shutdown, submits it to the existing authenticated plan endpoint, and waits for child delivery instead of publishing the plan as an answer/artifact. Child processes cannot create recursive plans. Parent delivery gathers server-validated current VERIFY evidence, preserving exact-version handoff checks. No host login state or model credentials enter the sandbox. A usable model connection is needed for real acceptance and must be distinguished from deterministic test adapters.

Rebuild the already authorized standalone deployment after checks. Validate configuration persistence, default Aida on a local computer, single-Aida delivery, WORK/VERIFY/Aida aggregation, LAN HTTP drive/download and mobile rendering. Retain truthful per-scenario evidence and explicit remaining exclusions.

The user selected the local Codex login broker. A reviewed admission explicitly selects `codex-login` instead of the default `server` provider. The trusted supervisor reads the current owned, private Codex login file, sends inference only to the fixed native Codex Responses endpoint, and does not refresh or copy login credentials. A durable server permit validates Task sources/tools/model and reserves any governed budget before transfer. A single-use receipt records provider usage and rechecks current Task state before releasing the response into the namespace; duplicate receipts cannot double-charge or double-record. Failed calls retain unknown budget reservations. Native SSE output items are collected explicitly because the completion event may omit them.

## Discoverable configuration and IM group defaults

Expose a dedicated configuration view from the desktop rail and mobile Me page, retaining the shared configuration component and workspace role gates. Channel means the existing IM group conversation; one-to-one conversations remain one-to-one. Group configuration names that relationship directly.

Create or reuse one active workspace Aida through the existing quota/placement creation service, serialized by the company Task lock. Prefer a paired local Codex computer; otherwise leave placement visibly unconfigured, without selecting cloud execution. Group creation auto-includes Aida even when no professional teammate is selected and initializes its immutable coordinator definition and binding in the group transaction. Existing group opening calls an authenticated, idempotent initializer: validate the caller's current group membership before installing identity, use the existing membership/history/outbox path for an actual join, then initialize missing bindings under the Task lock. Preserve any explicitly configured default, do not restore ended bindings, and do not activate TASK or import prior group history as approved Task inputs. Schema-14 LEGACY compatibility must remain runnable without Task binding tables.

Display the actual default member in the group and provide a clear configuration action. Qualification, quota, membership or initialization failures must be visible. Browser acceptance must start from ordinary frontend navigation and group creation, without manually seeding test definitions, members or bindings as a substitute for this behavior, and must inspect the user's actual workspace.

Initialize missing professional member bindings too, reusing same-workspace immutable definitions when available, otherwise publishing a scoped WORK/VERIFY definition from the member profile. Do not copy another group's binding overrides, grants, inputs or memory. Existing active bindings are preserved. Setting the initially missing default flag alone does not invalidate an existing task context.
