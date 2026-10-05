# Tasks

## 1. Schema and compatibility

- [x] 1.1 Append migration 15 for definitions, bindings, workspace modes, tasks, grants, inputs, contexts, dispatch, plans, artifacts, knowledge and operation facts; verify immutable checksums and real PostgreSQL constraints.
- [x] 1.2 Register schema compatibility and lifecycle/test cleanup handling without editing historical SQL; verify version-14 preparation behavior and migration tests.

## 2. Task and authorization services

- [x] 2.1 Implement typed associated grant validation, attenuation, destination and provenance rules; verify cross-product, invalid scope and revoked-source unit cases.
- [x] 2.2 Implement live Binding eligibility, definition versions and explicit workspace preparation/readiness; verify removed/rejoined member and tenant isolation integration cases.
- [x] 2.3 Implement idempotent task creation, approved inputs, supplements, drive/cancel/scope revisions and context resolution; verify channel ownership, ambiguity and unauthorized drivers against PostgreSQL.
- [x] 2.4 Implement resource/connection/grant configuration with verifiable authority, identity defaults and revocation; verify copied-bundle denial and no implicit account switching.

## 3. Dispatch and cloud execution

- [x] 3.1 Implement durable exclusive dispatch claims, generations and unknown/stopped reconciliation; verify duplicate notifications, reconnect and lease-expiry races.
- [x] 3.2 Implement a task-only cloud loop with tracked model calls, approved context and fixed checked tools; verify direct response and tool work without inbox, FUSE or runner-credential exposure.
- [x] 3.3 Seal legacy turn, CLI, filesystem, history, memory and steer bypasses in task mode; verify forbidden accesses and other-task input never reach the task model.
- [x] 3.4 Route scheduler/wake transport to durable task work while preserving legacy mode; verify published delivery does not trigger new work and failed task dispatch does not fan out.

## 4. Artifacts, publication and knowledge

- [x] 4.1 Implement immutable artifact versions, private content access and version-bound verification; verify hash mismatch and unauthorized reference reads.
- [x] 4.2 Implement current-source/audience delivery transaction and group membership history gate; verify concurrent revoke/member/publication races and Redis-down outbox recovery.
- [x] 4.3 Implement source-aware Channel/Agent knowledge candidates, retrieval, explicit publication and invalidation; verify pinned/unknown-source/cached/raw-file and embedding-destination restrictions.
- [x] 4.4 Document the task, access, artifact and knowledge API contracts with tested request examples and verify all public/runtime routes reject spoofed identities.

## 5. Aida plans and governance

- [x] 5.1 Implement bounded DAG validation and one-level same-channel delegation with attenuated grants; verify cycles, depth, limits and read-only-coordinator behavior.
- [x] 5.2 Implement dependency dispatch, immutable child handoff and evidence-based parent completion; verify repair/independent-verification/summary workflow.
- [x] 5.3 Implement card/action/artifact mapping preserving original mandates, budgets and review states; verify task delivery never bypasses card finalization.

## 6. Local runtime and cross-environment handoff

- [x] 6.1 Implement versioned local runtime task admission and task-scoped engine/session/filesystem/environment boundaries; verify old/unqualified engines cannot execute or fall back.
- [x] 6.2 Implement authenticated local task dispatch/actions/results with exact artifact consumption and per-task steer; verify local validation and cross-task isolation.
- [x] 6.3 Implement durable external operation idempotency and unknown-result reconciliation without automatic write replay/device migration; verify timeout-after-write and disconnect cases.
- [x] 6.4 Document supported runtime/adapter guarantees and run actual process/file/connection boundary tests for each admitted combination.

## 7. Entrypoints, UI and migration

- [x] 7.1 Route REST/WS messages, calendar, board, API, idle/scanner/poll work through authorized Channel Task ingress; verify every entrypoint blocks without a channel or automation authority.
- [x] 7.2 Implement client task references, ambiguous-task selection, cancellation, blocked status and delivery links in desktop/mobile chat; verify frontend types and interaction tests.
- [x] 7.3 Implement workspace cutover/readiness, safe old-data mapping, legacy-work/unknown-operation stop checks and rollback behavior; verify mixed-mode and schema compatibility tests.
- [x] 7.4 Add lifecycle handling for offboarding, device revoke, workspace deletion, retention and GC; verify active artifacts retained and references disposed according to policy.
- [x] 7.5 Document preparation, opt-in, rollback and acceptance procedures with executable commands; verify the documented test workflow runs in a dedicated environment.

## 8. End-to-end verification

- [x] 8.1 Run strict OpenSpec validation, server/frontend typechecks and affected guards; resolve all introduced failures.
- [x] 8.2 Run meaningful unit, real PostgreSQL/Redis integration and cloud/local workflow tests mapping I01-I12 and A01-A30; retain a truthful verification report and confirm no skipped required checks.
- [x] 8.3 Review working-tree changes against the unchanged conceptual data flows, confirm all tasks implemented, and report completion without deploying or archiving automatically.

## 9. Browser repairs and local acceptance

- [x] 9.1 Add administrator configuration reads and shared workspace/channel pages for definition versions, bindings, atomic defaults, readiness and local admission evidence; verify persistence without changing Agent creation behavior.
- [x] 9.2 Fix LAN HTTP request IDs and hash-checked downloads, root task selection and cancelled-task block display; verify both desktop/mobile interactions.
- [x] 9.3 Add local coordinator plan submission, eligible context and current verification evidence aggregation; verify real Codex/HTTP/PostgreSQL local-only Aida-WORK-VERIFY workflow and no recursive delegation.
- [x] 9.4 Establish a usable approved model connection for local execution, rebuild the deployed service, and run actual browser single-Aida/multi-Agent/configuration/LAN/mobile acceptance; record outcomes separately from deterministic model tests and exclude cloud/Agent-creation finding 4.

## 10. Ordinary workspace and IM group usability

- [x] 10.1 Provide a dedicated configuration page with visible desktop navigation and mobile entry, using the shared forms and identifying Channel as an existing IM group.
- [x] 10.2 Initialize one quota-compliant local-preferred workspace Aida and group default binding through normal group creation/opening; verify concurrent idempotency, explicit-default preservation, membership qualification and LEGACY compatibility.
- [x] 10.3 Rebuild/redeploy and use the ordinary browser paths for new solo/multi-Agent groups, configuration/mobile persistence and the user's gaohua chen workspace at port 5181; retain current truthful evidence.
