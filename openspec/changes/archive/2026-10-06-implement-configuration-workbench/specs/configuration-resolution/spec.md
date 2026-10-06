# Spec Delta

## Purpose

Resolve layered group and Agent configuration into an explainable effective view and immutable Task input while preserving existing execution eligibility checks, so configuration editing cannot silently expand resources or rewrite work already created.

## ADDED Requirements

### Requirement: Explicit resource selection modes
The system SHALL distinguish all, subset and none modes, intersect subset IDs with group references, and preserve an empty subset after its last reference is removed.

#### Scenario: Subset loses its last bundle
- **WHEN** the group removes the only Bundle selected by an Agent
- **THEN** its effective resource set is empty and no other group Bundle becomes available automatically

### Requirement: Language resolves with a concrete source
The system SHALL resolve concrete language values in the order binding, group, pinned Agent, workspace and product default, skipping inheritance markers without cycles.

#### Scenario: Group overrides agent
- **WHEN** a group sets Chinese, its Agent defaults to English and the binding inherits
- **THEN** effective language is Chinese with group as source

#### Scenario: All layers inherit
- **WHEN** upper layers specify inheritance
- **THEN** the preview displays the workspace or product default as a concrete value and source

### Requirement: Per-resource identity and scope preview
The system SHALL prefer explicit connection identity over Bundle default and show each resource's source version, identity origin, operation scope and connection readiness. Domain access SHALL carry no implicit login credentials.

#### Scenario: Mixed identities
- **WHEN** a Bundle has a project default identity but MCP and GitHub connections have explicit identities
- **THEN** the preview shows their actual explicit identities and tools or repository branch, path and actions

### Requirement: Task configuration snapshots
The system SHALL snapshot resolved instructions, Skill content, language and resource references for root and delegated Tasks at creation. Configuration-only updates SHALL affect new Tasks without rewriting or revoking existing Task snapshots; membership, authorization and runtime changes SHALL remain live checks.

#### Scenario: Upgrade after claim
- **WHEN** group configuration is upgraded after a Task is created and claimed
- **THEN** the existing execution continues with its original snapshot and a newly created Task uses the upgraded configuration

#### Scenario: Runtime changes
- **WHEN** the Agent is removed or its runtime assignment changes
- **THEN** existing execution remains blocked by eligibility checks even though its snapshot is immutable

### Requirement: Configured resources do not imply execution authority
The system SHALL persist MCP, domain and GitHub configuration without implicitly creating credentials or execution grants, and SHALL show unqualified adapter status explicitly.

#### Scenario: Save external resource configuration
- **WHEN** a user saves a resource with no qualified execution adapter
- **THEN** its configuration can be previewed and snapshotted while its execution status remains unqualified
