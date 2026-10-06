# configuration-workbench Specification

## Purpose

Provide a desktop workspace for managing reusable Agent definitions, Skills and access resources alongside existing IM groups, with durable server data and explicit version choices that remain consistent across editing and execution.

## Requirements

### Requirement: Real workspace configuration objects
The system SHALL provide Agent, Skill, Access Bundle and group configuration pages using existing participant and conversation identities, with server-persisted configuration and local computer placement.

#### Scenario: Default and multiple agents
- **WHEN** the user opens an Aida-only group or a group with professional agents
- **THEN** the page shows its actual members, default responsible agent and independent group configuration

### Requirement: Immutable publication and explicit upgrade
The system SHALL publish immutable Agent, Skill and Bundle versions, pin all references, show current and latest versions, and change references only through explicit selection or upgrade.

#### Scenario: New bundle version
- **WHEN** Bundle v3 is published while a group references v2
- **THEN** ordinary picker confirmation retains v2 and explicit upgrade changes the reference to v3

#### Scenario: Agent and Skill updates
- **WHEN** an Agent or Skill publishes a new version
- **THEN** existing references retain their exact version and content until explicitly upgraded

### Requirement: Reliable editing and import
The system SHALL preserve drafts on save failure and navigation confirmation, select an existing object after discard, and preserve Skill picker context and selections through nested import.

#### Scenario: Discard new object
- **WHEN** a newly created unsaved object is discarded
- **THEN** its detail is removed and a valid object or empty state can be edited without exceptions

#### Scenario: Import from member picker
- **WHEN** a user imports a Skill after making pending choices in a member picker
- **THEN** the original picker returns with prior choices and the new Skill selected, and confirmation changes only the current binding

### Requirement: Concurrent saves do not overwrite
The system SHALL reject writes based on stale configuration revisions and keep the user's draft available for reload or retry.

#### Scenario: Two editors
- **WHEN** two editors save changes from the same revision
- **THEN** the first save succeeds and the second receives a conflict without replacing the first save
