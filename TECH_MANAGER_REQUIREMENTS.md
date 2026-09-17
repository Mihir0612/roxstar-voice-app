# TECH_MANAGER_REQUIREMENTS.md

# Roxstar — Voice Draft, Real-Time Room and Spin Wheel System

> **Source of truth:** Roxstar Candidate Technical Assessment PDF.
>
> This document extracts and organizes the requirements from the assessment. It does not implement code.

---

## 1. Project Overview

### Product

The project is a connected system containing three capabilities:

1. Local voice recording and voice effects on Android using Oboe.
2. Real-time room participation using a Node.js backend and WebSocket/Socket.IO.
3. A multiplayer spin wheel played by users inside a room.

Live audio streaming, WebRTC, LiveKit, AI, Kubernetes, and multi-tenant architecture are explicitly outside the scope.

### Main User Journey

```text
Record voice clip on Android using Oboe
        ↓
Apply Echo / Reverb / Pitch Shift
        ↓
Save as Draft
        ↓
Create or join a room
        ↓
Receive participant updates
        ↓
Share a Draft with the room
        ↓
Start Spin when eligible users are available
        ↓
Receive elimination events
        ↓
One participant remains
        ↓
Winner announced
        ↓
Retrieve final room and spin result
```

### Required Final Submission

- Private Git repository
- Android application and native Oboe code
- Node.js backend
- Database schema/migrations
- Tests
- Dockerfile
- CI/CD configuration
- Cloud deployment assets
- API documentation
- Architecture documentation/diagrams
- 5–10 minute demonstration recording
- Working cloud endpoint

---

# 2. Functional Requirements

## 2.1 Android Audio

The Android application must:

- Record microphone input using Oboe.
- Support Start, Stop, and Cancel.
- Save a valid local audio file.
- Handle microphone permission and expected failures.
- Apply at least one of:
  - Echo
  - Reverb
  - Pitch Shift
- Use the Oboe/native audio path for the effect where practical.
- Support playback of saved recordings.

### Audio flow

```text
Microphone
    ↓
Oboe Input Stream
    ↓
Effect Processing
    ↓
Encoding / File Writer
    ↓
Local Draft Storage
    ↓
Playback
```

## 2.2 Draft Management

Drafts must support:

- Save recording as Draft
- List Drafts
- Show Draft name
- Show creation time
- Show duration
- Play Draft
- Delete Draft

---

## 2.3 Room Management

The system must support:

- Create Room
- Join Room
- Leave Room
- Get Room Details
- Get participant list
- Share a selected Draft with the room

The backend owns the authoritative room state.

---

## 2.4 Real-Time Communication

Mandatory real-time events:

| Event | Required behavior |
|---|---|
| `user_joined` | Broadcast updated participant information |
| `user_left` | Broadcast departure and clean presence after leave/disconnect |
| `draft_shared` | Notify room members that a Draft was shared |
| `spin_started` | Publish active spin, eligible players and initial sequence state |
| `user_eliminated` | Publish each elimination and updated remaining players |
| `winner_announced` | Publish final winner and completed spin state |
| `room_state` | Return latest state after connection/reconnection |

Connection/disconnection handling and reconnect/state synchronization are required.

---

## 2.5 Spin Wheel

### Core rules

- Minimum eligible users: 3
- Maximum eligible users: 20
- Admin or room owner starts the spin manually.
- Only one active spin may exist in a room.
- After starting, eliminate one active participant every 5 seconds.
- Last remaining participant is the winner.
- Result must be persisted.
- Complete event sequence must be broadcast.
- Virtual points may be awarded to the winner.
- Payment, wallet, and real-money functionality are not required.

### State machine

```text
WAITING
   │
   ▼
RUNNING
   │
   ├───────────────┐
   │               │
   ▼               ▼
COMPLETED        ABORTED
```

### Required edge-case reasoning

The implementation/documentation must address relevant cases including:

- Duplicate start requests
- Simultaneous joins
- User departure during a spin
- Reconnect during a spin
- Admin disconnect
- Insufficient players
- Last players leaving
- Duplicate events
- Delayed timers
- Server restart

At least three edge cases must be demonstrated in the final demonstration.

---

# 3. Backend API Requirements

The required APIs/services are:

| Operation | Purpose |
|---|---|
| Create Room | Create a room |
| Join Room | Add a user to a room |
| Leave Room | Remove a user from a room |
| Get Room State | Retrieve current room state |
| Share Draft | Share a selected Draft |
| Start Spin | Start the room spin |
| Get Spin State / Result | Retrieve spin state or final result |
| Health / Readiness | Verify service health/readiness |

The exact HTTP paths, request schemas, response schemas, authentication mechanism, and error codes are implementation decisions that must be documented before coding. They must remain consistent across backend and client.

---

# 4. Database Requirements

The assessment identifies these entities:

| Entity | Purpose |
|---|---|
| User | Participant identity and profile metadata |
| Room | Room owner, status and timestamps |
| RoomMember | Membership and connection state |
| Draft | Recording metadata and hosted file location |
| Spin | Room, status, start/completion time and winner |
| SpinParticipant | Eligibility, elimination order/time and final status |
| SpinEvent / Result | Auditable events or final outcome |

Database selection may be:

- PostgreSQL
- MySQL
- MongoDB

The implementation must justify:

- Schema
- Keys
- Relationships
- Constraints
- Indexes
- Persistence correctness

---

# 5. Non-Functional Requirements

## Reliability

The system must correctly handle connection/disconnection, reconnect, state synchronization, invalid operations, and relevant spin edge cases.

## State Consistency

Room state and spin state must remain authoritative and consistent.

The backend owns:

- Room state
- Spin state
- Validation
- Persistence
- Event broadcasting

## Validation

Invalid operations must be detected and handled.

Validation applies to:

- Room operations
- Spin operations
- Participant eligibility
- API requests
- WebSocket operations

## Error Handling

The system must handle expected failures, including Android microphone permission/failure cases and backend/API invalid operations.

The final demonstration must show one expected failure and explain its handling.

## Idempotency

Backend quality requirements explicitly include validation, error handling, and idempotency.

Idempotency must be considered especially for operations such as repeated start requests and duplicate event/request handling.

## Performance

The Android audio path must use the high-performance native Oboe audio pipeline.

Spin timing must process one elimination every 5 seconds.

## Maintainability

Backend API/service organization, Android separation of concerns, meaningful project structure, tests, logging, and documentation are required by the assessment.

## Logging

Backend quality includes logging. Logging should support diagnosing API, room, spin, and deployment issues without exposing sensitive configuration.

## Testing

Required quality evidence includes:

- Unit tests
- Integration tests
- Correct API behavior
- Spin logic behavior
- Edge-case testing
- Final integrated-system testing

---

# 6. Technology Requirements

## Explicitly required / permitted by the assessment

```text
Android
Oboe
Node.js
WebSocket / Socket.IO
PostgreSQL / MySQL / MongoDB
Docker
AWS / GCP / Azure
```

### Technology constraints

- Oboe is used for Android microphone capture, playback and voice-effect processing.
- WebSocket/Socket.IO is used for room and spin events.
- WebSocket/Socket.IO does NOT carry live audio.
- Node.js owns room state, spin state, validation, persistence and event broadcasting.
- Docker is required for backend packaging.
- Final hosting must be on AWS, GCP, or Azure.
- Local-only final deployment is not accepted.

No additional technology is approved at this stage unless it is justified against an actual requirement.

---

# 7. High-Level Architecture

```text
┌───────────────────────────────────────┐
│            Android Application        │
│                                       │
│  UI / Room / Draft / Spin              │
│          │             │               │
│          │             ├── REST ───────┐
│          │             │               │
│          │             └── Socket.IO ──┤
│          │                             │
│  Native Oboe Audio                     │
│  Microphone → Effects → Local Draft    │
└───────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────┐
│             Node.js Backend            │
│                                        │
│ REST API                               │
│ WebSocket / Socket.IO                  │
│ Room Service                           │
│ Spin Service                           │
│ Validation                             │
│ Persistence                            │
│ Logging                                │
└────────────────┬───────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────┐
│              Database                  │
│                                        │
│ User                                   │
│ Room                                   │
│ RoomMember                             │
│ Draft                                  │
│ Spin                                   │
│ SpinParticipant                        │
│ SpinEvent / Result                     │
└────────────────────────────────────────┘
```

### Important architectural boundary

The Android Oboe audio path is local. The assessment does not require live audio streaming.

The backend is authoritative for room and spin state.

---

# 8. WebSocket Event Contract

## `user_joined`

**Emitter:** Backend after valid room join.

**Receivers:** Other/current room members as appropriate.

**Purpose:** Broadcast updated participant information.

**State change:** Room membership/presence is updated.

**Reconnect:** Reconnected clients must be able to recover latest room state.

---

## `user_left`

**Emitter:** Backend after explicit leave or detected disconnect.

**Receivers:** Room members.

**Purpose:** Broadcast departure and clean presence.

**State change:** Membership/connection state is updated.

---

## `draft_shared`

**Emitter:** Backend after successful draft-sharing operation.

**Receivers:** Room members.

**Purpose:** Notify that a Draft has been shared.

**State change:** Room's shared-draft state/persistence is updated as required by the implementation.

---

## `spin_started`

**Emitter:** Backend after valid spin start.

**Receivers:** Room members.

**Purpose:** Publish:

- Active spin
- Eligible players
- Initial sequence state

**State change:** Spin transitions to RUNNING.

---

## `user_eliminated`

**Emitter:** Backend every 5 seconds while the spin is running.

**Receivers:** Room members.

**Purpose:** Publish the eliminated user and updated remaining players.

**State change:** Spin participant status/order is updated.

---

## `winner_announced`

**Emitter:** Backend when one participant remains.

**Receivers:** Room members.

**Purpose:** Publish final winner and completed spin state.

**State change:** Spin transitions to COMPLETED and result is persisted.

---

## `room_state`

**Emitter:** Backend in response to connection/reconnection/state recovery.

**Receivers:** Connecting/reconnecting client.

**Purpose:** Return the latest authoritative room state.

---

# 9. Spin State and Concurrency Rules

## Valid lifecycle

```text
WAITING → RUNNING → COMPLETED
                                   → ABORTED
```

## Start validation

Before starting:

1. User must have appropriate room owner/admin authority.
2. There must be 3–20 eligible users.
3. There must not already be an active spin.

## Concurrent start requests

The backend must prevent two simultaneous requests from creating two active spins.

The exact locking/transaction/idempotency mechanism is an implementation decision and must be justified by the Backend Developer.

## Participant departure

If a participant leaves during a spin, the backend must apply a defined, consistent eligibility/state rule and broadcast/persist the resulting state.

If the PDF does not specify the exact rule, mark the detailed behavior:

`NEEDS CLARIFICATION / ARCHITECTURE DECISION REQUIRED`

Do not silently invent the business rule.

## Reconnection

A reconnecting client must be able to obtain the latest authoritative room/spin state through `room_state` / state recovery.

## Timer handling

The spin must produce eliminations every 5 seconds.

Timer reliability, delayed timers, and server restart behavior must be explicitly considered.

The exact recovery mechanism is an implementation decision and must be documented.

---

# 10. Security Requirements

The PDF explicitly requires validation, error handling, idempotency, environment configuration and secrets handling. Security must therefore be designed as part of the backend rather than added blindly later.

## Required security areas to analyze

### Input validation

Validate API and WebSocket payloads before processing.

### Authentication / Authorization

The implementation must establish how user identity and permissions are verified.

Room owner/admin operations must not be available to unauthorized users.

### Room ownership

Only an authorized owner/admin should be able to start a spin.

### WebSocket validation

Do not trust client-supplied room state, participant state, spin state, or privileged actions.

### Injection protection

Use safe database access and validated input.

### Rate limiting

Evaluate rate limiting for public API and abuse-prone operations.

The exact mechanism is an implementation decision.

### Secrets

Secrets must not be committed to the repository.

Use environment-based configuration.

### Error messages

Do not expose sensitive internal implementation details.

### CORS / HTTP security

Configure according to the actual deployed client/backend architecture.

Do not use an unrestricted production configuration without justification.

### Logging

Do not log secrets or sensitive authentication information.

---

# 11. Task Breakdown

## Tech Manager

### Task
Own requirements, architecture, acceptance criteria and cross-team decisions.

### Reason
Prevent developers from independently changing project requirements.

### Dependency
Complete PDF analysis.

### Expected output
`TECH_MANAGER_REQUIREMENTS.md`

### Acceptance criteria
All PDF requirements are categorized and architecture/task dependencies are documented.

---

## Android Developer

### Task
Implement Android audio studio and native Oboe path.

### Reason
Audio recording/effects are a core assessment section.

### Dependency
Approved architecture and audio requirements.

### Expected output
Android application + native Oboe implementation.

### Acceptance criteria
Recording, Start/Stop/Cancel, effect, Draft lifecycle and playback work.

---

## Frontend / Client Developer

### Task
Implement client UI and client-side communication for approved room, Draft and spin flows.

### Reason
Provide the user interface and client integration.

### Dependency
Approved backend API/WebSocket contracts.

### Expected output
Client implementation plan and implementation.

### Acceptance criteria
Client uses the approved contracts and correctly handles loading, errors, connection/reconnection and state updates.

---

## Backend Developer

### Task
Implement Node.js REST APIs, real-time service, room state, spin state, validation, persistence, security and tests.

### Reason
The backend is authoritative for room and spin behavior.

### Dependency
Approved architecture and database design.

### Expected output
Backend, database schema/migrations, API documentation and tests.

### Acceptance criteria
Required APIs/events work, spin rules are enforced, state is persisted, and security/edge cases are tested.

---

## Junior Android Developer

### Task
Work only on tasks explicitly delegated by the Senior Android Developer.

### Reason
Maintain senior review and architectural consistency.

### Dependency
Senior developer task assignment.

### Expected output
Small scoped implementation/test work.

### Acceptance criteria
Senior Android Developer reviews and accepts the work.

---

## Junior Backend Developer

### Task
Work only on tasks explicitly delegated by the Senior Backend Developer.

### Reason
Prevent unreviewed backend/security changes.

### Dependency
Senior backend developer assignment.

### Expected output
Small scoped implementation/test work.

### Acceptance criteria
Senior Backend Developer validates correctness and security.

---

## Junior Developer

### Task
Assist with clearly scoped implementation, testing, documentation or integration work.

### Reason
Support senior developers without bypassing review.

### Dependency
Task assigned by relevant senior developer.

### Expected output
Defined task output.

### Acceptance criteria
Senior developer reviews the result before integration.

---

## DevOps Engineer

### Task
Package, test and deploy the backend using Docker, CI/CD and a supported cloud provider.

### Reason
Cloud deployment is a scored assessment requirement.

### Dependency
Integrated backend and passing tests.

### Expected output
Dockerfile, CI/CD, cloud deployment, configuration and verification evidence.

### Acceptance criteria
Hosted endpoint is reachable and the actual application flow works online.

---

## QA / Testing

### Task
Test unit, integration, real-time, spin, edge-case and end-to-end behavior.

### Reason
Correctness and reasoning are major assessment criteria.

### Dependency
Implementations from development teams.

### Expected output
Test results and defect reports.

### Acceptance criteria
Critical flows and required edge cases are verified.

---

# 12. Risk Analysis

| Risk | Impact | Probability | Mitigation | Owner |
|---|---|---:|---|---|
| Oboe stream lifecycle errors | High | Medium | Explicit lifecycle handling and repeated-operation testing | Android |
| Microphone permission/failure | Medium | Medium | Permission and failure handling | Android |
| REST/WebSocket contract mismatch | High | Medium | Shared API/event contract and integration audit | Backend + Client |
| Concurrent spin start | High | Medium | Server-authoritative validation and concurrency-safe implementation | Backend |
| Duplicate events/requests | High | Medium | Idempotency and event/state validation | Backend |
| User disconnect during spin | High | Medium | Explicit state/eligibility policy and tests | Backend |
| Reconnect state mismatch | High | Medium | Authoritative `room_state` recovery | Backend + Client |
| Delayed spin timers | High | Medium | Timer/state verification and recovery strategy | Backend |
| Server restart during active spin | High | Medium | Persist required spin state/events and define recovery behavior | Backend |
| Database consistency issues | High | Medium | Constraints, indexes, appropriate persistence strategy and tests | Backend |
| API/WebSocket abuse | High | Medium | Authentication/authorization, validation and rate-limit analysis | Backend |
| Secrets exposed | High | Low | Environment configuration and secret handling | Backend + DevOps |
| Deployment succeeds but application fails online | High | Medium | External health and end-to-end verification | DevOps |
| APK points to localhost | High | Medium | Production environment configuration and APK verification | Full Stack + DevOps |
| Cloud/WebSocket configuration failure | High | Medium | Test actual WebSocket connection after deployment | DevOps |
| Insufficient players | Medium | High | Server-side eligibility validation | Backend |
| Visual polish consumes time over core correctness | Medium | Medium | Prioritize scored functional requirements | Tech Manager + Client |

---

# 13. Out of Scope

The following are explicitly outside the project scope:

```text
Live audio streaming
WebRTC
LiveKit
AI
Kubernetes
Multi-tenant architecture
Payment
Wallet
Real-money implementation
```

These must not be added as project requirements.

---

# 14. Acceptance Criteria

The final implementation must demonstrate:

- Oboe voice recording.
- At least one allowed voice effect.
- Draft save/list/play/delete.
- Room creation and joining.
- Room leave behavior.
- Required WebSocket events.
- Spin with at least 3 users.
- Elimination every 5 seconds.
- Exactly one winner.
- Result persistence.
- Reconnect/state recovery.
- At least three implemented edge cases.
- Automated tests.
- Docker packaging.
- CI/CD.
- AWS/GCP/Azure deployment.
- Hosted endpoint.
- Expected failure handling.
- Required documentation.

---

# 15. Documentation Requirements

The final repository must include:

```text
README.md
System architecture diagram
Audio-flow diagram
Room/WebSocket event-flow diagram
Spin state-machine / sequence diagram
API documentation
Database schema/migrations
Assumptions
Edge cases
Trade-offs
Known limitations
```

The repository structure recommended by the assessment is:

```text
/android-app
/native-audio
/backend
/database
/infrastructure
/docs/architecture
/docs/api
/tests
README.md
```

---

# 16. NEEDS CLARIFICATION / IMPLEMENTATION DECISIONS

The PDF defines the required behavior but does not specify every low-level implementation detail.

The following must be decided and documented before implementation rather than silently assumed:

1. Exact API URL paths.
2. Exact request/response JSON schemas.
3. Authentication mechanism.
4. User identity creation/login flow, if required by the implementation.
5. Exact behavior when a participant leaves during an active spin.
6. Exact behavior when the room owner/admin disconnects during an active spin.
7. Exact active-spin recovery behavior after server restart.
8. Exact timer recovery strategy for delayed timers.
9. Exact database technology choice and justification.
10. Exact cloud architecture.
11. Exact CI/CD provider/configuration.
12. Exact client/frontend technology where the PDF does not mandate one.

These decisions must be reviewed against the PDF and must not introduce unsupported product requirements.

---

# 17. TECH MANAGER APPROVAL GATE

## STATUS

**CHANGES REQUIRED / NEEDS CLARIFICATION before implementation**

The core requirements are sufficiently defined to create the architecture and developer plans, but the unresolved implementation decisions above must be explicitly decided before developers begin implementation.

## APPROVED TECHNOLOGY BASELINE

```text
Android
Oboe
Node.js
WebSocket / Socket.IO
One approved database:
    PostgreSQL OR MySQL OR MongoDB
Docker
One approved cloud:
    AWS OR GCP OR Azure
```

## APPROVED ARCHITECTURE PRINCIPLES

```text
Android owns local audio capture/effects/Draft playback.

Node.js owns authoritative room and spin state.

REST handles room/Draft/spin operations.

WebSocket/Socket.IO handles real-time room/spin events.

Database persists required entities and spin results/events.

Docker packages the backend.

Cloud deployment is required.

Client and backend must share explicit API/event contracts.
```

## DEVELOPER GATE

No production implementation should begin until:

```text
Tech Manager
    ↓
Architecture approved
    ↓
API/Event contracts approved
    ↓
Database choice approved
    ↓
Security approach approved
    ↓
Frontend implementation plan
    ↓
Backend implementation plan
```

---

# Final Manager Principle

```text
REQUIREMENT
    ↓
ANALYZE
    ↓
IDENTIFY UNKNOWN
    ↓
ARCHITECTURE DECISION
    ↓
APPROVAL
    ↓
DEVELOPER PLAN
    ↓
IMPLEMENT
    ↓
REVIEW
    ↓
INTEGRATE
    ↓
TEST
    ↓
DEPLOY
    ↓
VERIFY ONLINE
```

The manager does not ask developers to "just build it."

The manager first establishes what must be built, what must not be built, how the parts interact, what decisions remain open, and what acceptance criteria determine completion.
