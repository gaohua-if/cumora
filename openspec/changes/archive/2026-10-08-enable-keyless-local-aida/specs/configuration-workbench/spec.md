# Spec Delta

## ADDED Requirements

### Requirement: Visible local runtime capability
The system SHALL display server inference availability and explain that local Agents require an online paired computer and its own model login. The configuration view SHALL identify server-only capabilities that are unavailable without a key.

#### Scenario: Keyless workspace configuration
- **WHEN** a user opens desktop configuration on a keyless server
- **THEN** the view identifies local mode and the local computer login requirement without exposing credentials
