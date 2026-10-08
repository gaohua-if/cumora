# Tasks

## 1. Thread attachment input

- [x] 1.1 Accept attachment-only ingress, include fresh attachment metadata in scoped tools and enable bounded current-thread local text reads; document the input contract and pass PostgreSQL/HTTP tests for next-round work, provenance and URL refresh.

## 2. Desktop channel and thread behavior

- [x] 2.1 Unify root reply count for optimistic/WS/HTTP/discard/retry, merge drawer input and prevent asynchronous navigation takeover; pass behavioral store tests and frontend typecheck.
- [x] 2.2 Add root-aware channel pagination/projection, root entry and hidden-reply navigation, preserve drawer state across fetches; document desktop behavior and pass API pagination tests and production build.

## 3. Integrated acceptance

- [x] 3.1 Strictly validate OpenSpec and architecture guards, deploy 5181 and repository daemon, then complete browser acceptance for main-stream roots, nested replies, attachment-only continuation and delayed-send navigation; publish concrete evidence.
