# Spec Delta

## ADDED Requirements

### Requirement: Local account model selection
The system SHALL use an explicitly configured local Agent model or a verified local account catalog default for admitted Codex-login Task inference, and SHALL use the same resolved model for context and authorized requests.

#### Scenario: Server default unavailable locally
- **WHEN** the server model default is unsupported by the paired computer's account
- **THEN** local Task inference uses the resolved local Agent or account model instead

### Requirement: Keyless runtime admission
The system SHALL prevent server-model dispatch in local-only mode and allow qualified local Codex-login execution through the existing Task context and receipt paths.

#### Scenario: Server model runtime
- **WHEN** a local-only Task attempts a runtime that requires server inference
- **THEN** it reports a model connection requirement before attempting provider inference
