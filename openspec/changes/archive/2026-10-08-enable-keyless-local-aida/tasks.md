# Tasks

## 1. Keyless server

- [x] 1.1 Make the key optional and block server inference before credential discovery; verify empty-key startup imports and no provider network requests in subprocess tests, and document environment configuration.
- [x] 1.2 Skip embeddings/backfill and prevent managed wakes/synthetic server activation in local-only mode; verify memory fallback and unavailable model errors without network calls.

## 2. Durable Aida routing

- [x] 2.1 Append schemas 21/22 for durable exact member/default/quote/broadcast recipients across message writers; verify real database cases and immutable migration checksums.
- [x] 2.2 Replace scheduler semantic election and filter inbox before LIMIT with durable recipients; verify reconnect, direct specialist, coordinator completion with automatic reply quotes, mute/system notices and Task ingress addressing against PostgreSQL.

## 3. Runtime and configuration

- [x] 3.1 Resolve Codex-login Task models from local Agent/account configuration and reject server-model dispatch locally; verify context/authorize consistency and admission behavior in tests.
- [x] 3.2 Expose non-sensitive runtime capabilities in configuration and explain local login/unavailable server features in the desktop UI; verify API and browser rendering and document usage.

## 4. Deployed acceptance

- [x] 4.1 Pass relevant unit/database tests, frontend/server typechecks, build, affected guards and strict OpenSpec validation; record verification results.
- [x] 4.2 Deploy schema 22 and remove server model keys, then run actual browser/local Codex tests for solo Aida, multi-Agent default work, direct specialist and Aida cooperation; record replies, recipients, model usage, image/source identity and no server-model calls.
