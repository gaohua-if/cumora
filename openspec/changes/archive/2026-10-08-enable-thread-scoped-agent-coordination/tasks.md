# Tasks

## 1. Durable thread and native task adapter

- [x] 1.1 Append schema 23 and transactional automatic thread ingress; verify migration tests and PostgreSQL thread/quote/round isolation tests, document the native adapter contract.
- [x] 1.2 Implement bounded delegation, result artifacts, deterministic aggregation, blocker/failure/timeout recovery and deduplication; verify PostgreSQL multi-member, peer-mention, stale round and duplicate result tests.

## 2. Local runtime and session isolation

- [x] 2.1 Add thread-bound runtime claims, scoped inbox/history/reply/read tools and finish handling; verify runtime integration tests and existing protected TASK regression.
- [x] 2.2 Switch daemon to thread-specific session stores and working directories, queue unrelated thread messages and resume follow-ups; verify session isolation tests, typecheck and document lifecycle.

## 3. Desktop thread experience

- [x] 3.1 Carry threadId through API, realtime and message stores; display nested replies, member/task status and open new task thread automatically; verify frontend typecheck/build and browser interactions.

## 4. Deployment and end-to-end acceptance

- [x] 4.1 Run focused integration/regression checks and strict OpenSpec validation; deploy schema/server and repository daemon on 5181; verify health and keyless local login execution.
- [x] 4.2 Complete browser and real model acceptance for multi-member aggregation (including peer mentions and blocked member), two concurrent threads and follow-up session continuity; publish evidence with task/session/artifact/delivery IDs and mark tasks only after validation passes.
