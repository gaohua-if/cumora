# Spec Delta

## ADDED Requirements

### Requirement: Aida owns semantic coordination
The system SHALL deliver unaddressed group work to its default responsible Agent, normally Aida. Exact mentions by member ID, name or binding alias and human quotes of Agent replies SHALL address those members directly; only explicit @all SHALL broadcast. Aida SHALL decide its own work, delegation and synthesis without a separate server model router.

#### Scenario: Multiple agents without mentions
- **WHEN** a human sends ordinary work to an Aida and specialist group
- **THEN** only its default Agent receives initial work and can ask eligible peers to cooperate

#### Scenario: Direct specialist
- **WHEN** a human exactly mentions a specialist or quotes its reply
- **THEN** that specialist receives the work and Aida does not automatically take it over

#### Scenario: Explicit broadcast
- **WHEN** a member uses @all
- **THEN** eligible group Agents receive the broadcast without a server classifier

### Requirement: Durable message recipients
The system SHALL persist work recipients with each ordinary message and use them for both wakes and unread inbox recovery. Membership, mute exceptions and durable system notices SHALL retain their existing checks.

Agent-authored quotes SHALL preserve reply context without independently addressing a peer; explicit mentions SHALL still delegate.

#### Scenario: Coordinator quotes completed work
- **WHEN** Aida posts an unmentioned completion quoting a specialist result
- **THEN** no Agent receives new work from that completion


#### Scenario: Reconnect without wake
- **WHEN** a specialist reconnects after unaddressed group messages and a subsequent targeted message
- **THEN** its inbox offers the targeted work without offering the default Agent's unrelated work

#### Scenario: Coordinator completes
- **WHEN** Aida posts an unaddressed completion message
- **THEN** the message remains visible to the group without waking Aida or all specialists again
