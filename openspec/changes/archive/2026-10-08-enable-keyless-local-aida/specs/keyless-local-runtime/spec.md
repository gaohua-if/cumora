# Spec Delta

## Purpose

Allow Cumora to host durable IM and configuration services without server model credentials, while paired local agents use their own logged-in model runtimes and unsupported server model features report their actual availability.

## ADDED Requirements

### Requirement: Keyless server startup
The system SHALL start without OPENAI_API_KEY and automatically disable server model inference when no server key is configured, while retaining database, realtime, configuration and paired computer services.

#### Scenario: Empty key deployment
- **WHEN** the deployed server has an empty or absent OpenAI key
- **THEN** health, authenticated configuration and messaging work without a placeholder key

### Requirement: No hidden server model credentials
The system SHALL reject server inference before provider discovery or network calls in local-only mode, including tenant credentials and auxiliary model paths. Local model login credentials SHALL stay on the paired computer.

#### Scenario: Previously configured tenant
- **WHEN** a tenant has an existing model key but deployment runs local-only
- **THEN** no server model call uses that key and a requested server inference receives an explicit unavailable error

### Requirement: Keyless auxiliary behavior
The system SHALL skip embeddings and preserve pinned and recent memory retrieval without server inference. Server-generated images SHALL report unavailability, and unavailable synthetic server classifiers SHALL not cause uncontrolled agent activation.

#### Scenario: Memory without embeddings
- **WHEN** local-only agents save and retrieve memory
- **THEN** memory remains usable without requests to an embedding provider

#### Scenario: Image request
- **WHEN** the user requests a generated avatar in local-only mode
- **THEN** the service reports server model unavailability without an outbound model request
