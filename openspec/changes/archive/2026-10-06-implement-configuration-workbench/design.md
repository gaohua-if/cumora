# Design

## Context

See proposal.md for motivation and `docs/prototypes/configuration-workbench-v2/DESIGN.zh-CN.md` for the reviewed product design. Existing definitions, bindings, Bundle versions and Task snapshots already exist. The current definition API accepts only name/role/instructions; configuration UI lacks Skills and Bundle metadata. Ordinary binding edits currently revoke execution contexts, which conflicts with configuration-only upgrades.

## Goals / Non-Goals

Goals: server-backed desktop editing matching v2; one effective projection; immutable references and root/child Task snapshots; preserve existing identities and runtime eligibility.

Non-goals: mobile redesign, cloud execution, new permission management or credential onboarding, and unqualified external adapter execution. Prototype-only snapshot demonstrations are not production Task creation APIs.

## Decisions

1. Add an append-only migration for Skill versions, workspace defaults/revisions, channel configuration and Bundle bodies. Extend definition/Binding JSON with validated fields. Existing tables are authoritative; do not store a second independent configuration graph.
2. New `/tasks/workbench` operations return real objects, publish immutable versions, save channel/Binding config and expose the effective projection. Version IDs reference tenant-qualified records. Workspace revision under the existing advisory transaction lock prevents overwrites. Existing create/member/runtime APIs keep identity and placement side effects.
3. A pure typed resolver is shared by preview and Task creation. Source labels and full resource fields are part of the response. Unqualified external resources remain metadata with readiness shown, while approved execution continues through existing grants/adapters.
4. Configuration-only Binding changes increment configuration revision, not execution eligibility. Add a separate eligibility fence initialized from existing binding versions; retain legacy edit revocation semantics and runtime assignment/membership checks. New Task and child Task creation resolve once; dispatch copies that immutable snapshot.
5. Implement the desktop workbench as React components in the existing settings route, keeping local execution readiness/admission separate. UI drafts never publish on navigation without explicit confirmation. Nested import retains picker state. Existing production data takes precedence over prototype fixtures.

## Risks / Trade-offs

- Existing definitions lack new fields → default empty Skills, inherited preferences and existing instructions; backfill only absent metadata without rewriting immutable versions.
- Configuration publication may be confused with live resource connection → readiness is explicit and metadata cannot create grants.
- Config edits and eligibility revocations share old version fields → separate fences, test claimed tasks across upgrades and assignment changes.
- Multiple editors → stale revision conflict with draft retained; no blind last-write-wins.

## Migration Plan

Append migration 20 and immutable manifest checksum, run in isolated Postgres, then upgrade deployment before using the workbench API. Existing workspaces retain execution mode and actual membership. Existing pages and task preparation remain available. Rollback UI/API exposure without deleting version rows; no destructive database downgrade or historical checksum rewrite.

## Implementation evidence

See `docs/verification/configuration-workbench-2026-10-05/README.zh-CN.md` for the deployed desktop application, database migration, snapshot checks and reproducible browser evidence. New groups select the latest version of their chosen Agent definition; initialization leaves existing bindings fixed. Persisted ordinary group settings activate full Task snapshots even for legacy three-field definitions. Mobile retains the existing TaskSettings page.
