Role: Senior Backend Developer — 15+ years experience
Source: TECH_MANAGER_REQUIREMENTS.md, FRONTEND_IMPLEMENTATION_PLAN.md, Roxstar assessment PDF, provided architecture image
Status: PLAN ONLY — NO PRODUCTION CODE
Gate: CHANGES REQUIRED / NEEDS CLARIFICATION

1. Requirements
Manager-approved backend requirements relevant to this plan:

Node.js backend is authoritative for room state, spin state, validation, persistence and event broadcasting.

REST handles room, Draft, spin and health/readiness operations.

WebSocket/Socket.IO handles real-time room and spin events.

Required real-time events:
user_joined, user_left, draft_shared, spin_started,
user_eliminated, winner_announced, room_state.

Required operations:
Create Room, Join Room, Leave Room, Get Room State, Share Draft,
Start Spin, Get Spin State/Result, Health/Readiness.

Spin rules:

3–20 eligible users.

Owner/admin starts manually.

Only one active spin per room.

One elimination every 5 seconds.

Last remaining participant wins.

Result persisted.

Complete event sequence broadcast.

Reconnect and authoritative state synchronization are required.

Required persistence entities:
User, Room, RoomMember, Draft, Spin, SpinParticipant, SpinEvent/Result.

Security, validation, error handling, idempotency, logging and tests are required.

Live audio streaming, WebRTC, LiveKit, AI, Kubernetes, multi-tenant, payment, wallet and real-money functionality are out of scope.

WebSocket/Socket.IO must not carry live audio.

2. Technology
The Tech Manager baseline approves Node.js, Socket.IO/WebSocket, one database, Docker and one cloud. Exact low-level choices remain NEEDS CLARIFICATION.

Area	Plan	Status
Runtime	Node.js	APPROVED
Language	JavaScript or TypeScript	NEEDS CLARIFICATION — recommendation: TypeScript
API framework	Fastify or Express	NEEDS CLARIFICATION — recommendation: Fastify
Database	PostgreSQL, MySQL or MongoDB	NEEDS CLARIFICATION — recommendation: PostgreSQL
WebSocket	Socket.IO	APPROVED by baseline
Validation	Zod / Joi / framework schema	NEEDS CLARIFICATION — recommendation: Zod
Authentication	Mechanism not specified by PDF	NEEDS CLARIFICATION
Authorization	Room owner/admin checks required	APPROVED principle
Testing	Unit, integration, WebSocket, concurrency, edge-case	REQUIRED
Logging	Structured logging with redaction	REQUIRED — recommendation: Pino
Docker	Required	APPROVED
CI/CD	Provider/configuration not specified	NEEDS CLARIFICATION
Cloud	AWS / GCP / Azure	NEEDS CLARIFICATION
No additional SDK, analytics, payment, AI or live-audio dependency will be added.

3. Backend Architecture
Proposed structure:

text
/backend
├── src/
│   ├── config/
│   ├── routes/
│   ├── controllers/
│   ├── services/
│   │   ├── room.service
│   │   ├── draft.service
│   │   ├── spin.service
│   │   └── presence.service
│   ├── repositories/
│   ├── models/
│   ├── websocket/
│   ├── middleware/
│   ├── validators/
│   ├── errors/
│   ├── logging/
│   └── server
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── websocket/
│   └── concurrency/
├── database/
│   ├── migrations/
│   └── seeds/
├── Dockerfile
└── README.md
Boundary:

text
REST API → Controllers → Services → Repositories → Database
Socket.IO → WebSocket handlers → Services → Repositories → Database
Rules:

Controllers validate transport input and delegate.

Services own business rules and transactions.

Repositories own database access.

WebSocket handlers must not trust client-supplied room, participant or spin state.

Backend emits authoritative events after successful persistence.

4. API Contract
Status: PROPOSED — NEEDS TECH MANAGER / BACKEND CONTRACT APPROVAL
Exact paths, schemas, auth and error codes remain NEEDS CLARIFICATION until approved.

Base path proposal: /api/v1
Auth proposal: Authorization: Bearer <token>
Error envelope proposal:

json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Safe user-facing message",
    "details": {}
  }
}
4.1 Create Room
Method: POST

URL: /api/v1/rooms

Auth: required

Request: { "name": "optional-string" }

Response: { "roomId", "ownerId", "status", "createdAt" }

Validation: authenticated user, optional name length.

Errors: 400, 401, 500.

Idempotency: Idempotency-Key recommended.

4.2 Join Room
Method: POST

URL: /api/v1/rooms/:roomId/join

Auth: required

Request: { "displayName": "optional-string" }

Response: { "roomId", "member", "joinedAt" }

Validation: room exists, user authenticated, duplicate join handled safely.

Errors: 400, 401, 404, 409, 500.

Idempotency: repeated join should not create duplicate membership.

4.3 Leave Room
Method: POST

URL: /api/v1/rooms/:roomId/leave

Auth: required and must be member.

Request: {}

Response: 204 No Content or { "roomId", "leftAt" }

Validation: membership exists.

Errors: 401, 403, 404, 500.

Idempotency: repeated leave returns success or safe no-op.

4.4 Get Room State
Method: GET

URL: /api/v1/rooms/:roomId/state

Auth: required and must be member.

Response:

json
{
  "room": {},
  "participants": [],
  "sharedDraft": {},
  "activeSpin": {}
}
Validation: membership and room existence.

Errors: 401, 403, 404, 500.

4.5 Share Draft
Method: POST

URL: /api/v1/rooms/:roomId/drafts/share

Auth: required and must be member.

Request proposal:

json
{
  "draftId": "string",
  "name": "string",
  "durationMs": 0,
  "hostedFileUrl": "optional-string"
}
Response: { "draftId", "sharedAt", "sharedBy" }

Validation: draft belongs to user, room membership, draft metadata valid.

Errors: 400, 401, 403, 404, 409, 500.

Idempotency: Idempotency-Key recommended.

BLOCKER: Whether Draft audio file upload/hosting is required is not specified. Live audio streaming is out of scope. Exact Draft-sharing file transfer contract is NEEDS CLARIFICATION.

4.6 Start Spin
Method: POST

URL: /api/v1/rooms/:roomId/spin/start

Auth: required; room owner/admin only.

Request: {} or { "idempotencyKey": "string" }

Response:

json
{
  "spinId": "string",
  "status": "RUNNING",
  "startedAt": "ISO-8601",
  "eligibleParticipants": []
}
Validation:

authorized owner/admin,

3–20 eligible users,

no active spin.

Errors: 400, 401, 403, 409, 500.

Idempotency: required. Duplicate start with same key returns existing spin; conflicting start returns 409.

4.7 Get Spin State / Result
Method: GET

URL: /api/v1/rooms/:roomId/spin

Auth: required and member.

Response:

json
{
  "spinId": "string",
  "status": "WAITING|RUNNING|COMPLETED|ABORTED",
  "eligibleParticipants": [],
  "remainingParticipants": [],
  "eliminatedParticipants": [],
  "winner": {},
  "startTime": "ISO-8601",
  "completionTime": "ISO-8601"
}
Errors: 401, 403, 404, 500.

4.8 Health / Readiness
GET /health — process liveness.

GET /ready — database and required dependencies.

No client polling except operational checks.

5. Real-Time Architecture
Proposed Socket.IO namespace: /rooms
Auth: token in handshake. Exact handshake is NEEDS CLARIFICATION.

Connection flow:

text
Client connects with auth
→ server validates identity
→ client subscribes to room
→ server validates membership
→ server emits room_state
Required events:

user_joined
Emitter: backend after valid join.

Receivers: room members.

Payload: { roomId, participant, eventId, occurredAt }

State: membership/presence updated.

Duplicate: client must not emit this event.

user_left
Emitter: backend after explicit leave or disconnect grace period.

Receivers: room members.

Payload: { roomId, userId, eventId, occurredAt }

State: presence updated.

Disconnect grace period is NEEDS CLARIFICATION.

draft_shared
Emitter: backend after successful share.

Receivers: room members.

Payload: { roomId, draft, sharedBy, eventId, occurredAt }

State: shared Draft updated.

Client must never emit authoritative draft_shared.

spin_started
Emitter: backend after valid start.

Receivers: room members.

Payload: { roomId, spinId, status, eligibleParticipants, startedAt, eventId }

State: spin transitions to RUNNING.

user_eliminated
Emitter: backend every 5 seconds while running.

Receivers: room members.

Payload: { roomId, spinId, eliminatedUserId, remainingParticipants, eliminatedAt, eventId }

State: elimination order and remaining players updated.

Client must never choose eliminated participant locally.

winner_announced
Emitter: backend when one participant remains.

Receivers: room members.

Payload: { roomId, spinId, winnerUserId, completedAt, eventId }

State: spin COMPLETED, result persisted.

room_state
Emitter: backend after connection/reconnection/subscription.

Receivers: requesting client.

Payload: authoritative room, participants, shared Draft and active spin state.

State: replaces stale client state.

Event ordering and duplicate handling:

Every event includes eventId.

Clients may deduplicate by eventId.

Server persists spin events before broadcasting.

room_state always wins after reconnect.

6. Spin Engine
State machine:

text
WAITING → RUNNING → COMPLETED
                 → ABORTED
Start validation:

User is room owner/admin.

Eligible users between 3 and 20.

No active spin for room.

Transaction/lock prevents concurrent starts.

Elimination loop:

Use persisted nextEliminationAt rather than only in-memory timers.

Every 5 seconds, transaction:

lock spin row,

verify status still RUNNING,

select one remaining participant by defined selection rule,

mark eliminated,

persist SpinEvent,

broadcast user_eliminated.

When one remains:

mark winner,

persist result,

broadcast winner_announced.

Persistence:

Spin stores status, timestamps, winner.

SpinParticipant stores eligibility, elimination order/time, final status.

SpinEvent stores auditable event sequence.

Recovery:

On server restart, read RUNNING spins.

Resume from persisted nextEliminationAt or defined recovery rule.

Exact restart/timer recovery behavior: NEEDS CLARIFICATION / ARCHITECTURE DECISION REQUIRED.

7. Concurrency
Issue	Protection
Two users join simultaneously	Unique constraint on (roomId, userId); transaction.
Two start-spin requests	Transaction + unique partial index on one active spin per room + idempotency key.
Duplicate requests	Idempotency-Key and deterministic response replay.
Multiple server timers	Single authoritative spin row; each tick locks and rechecks status.
User leaves during spin	Defined eligibility rule required. NEEDS CLARIFICATION.
Reconnect during spin	room_state and GET /spin return authoritative state.
Admin disconnects during spin	Behavior undefined by PDF. NEEDS CLARIFICATION.
Server restart	Persisted spin state and recovery job required. Exact rule NEEDS CLARIFICATION.
Duplicate events	eventId and client dedupe; server persists before broadcast.
Delayed timers	Compute based on persisted timestamps; avoid catch-up storms without defined policy.
8. Database
Recommended: PostgreSQL, because transactions, constraints, partial unique indexes and relational integrity fit room/spin rules. Final choice remains NEEDS CLARIFICATION.

Entities:

User
id

displayName

createdAt

Room
id

ownerId

status

createdAt

updatedAt

RoomMember
id

roomId

userId

role (OWNER, ADMIN, MEMBER)

membershipStatus

joinedAt

leftAt

lastSeenAt

Draft
id

ownerId

name

durationMs

hostedFileUrl or local reference metadata

createdAt

Spin
id

roomId

status

startedAt

completedAt

winnerUserId

nextEliminationAt

createdAt

SpinParticipant
id

spinId

userId

eligible

eliminationOrder

eliminatedAt

finalStatus

SpinEvent / Result
id

spinId

eventType

payload

createdAt

Constraints and indexes:

Unique (roomId, userId) on RoomMember.

One active spin per room: partial unique index on Spin(roomId) where status = 'RUNNING'.

Index Spin(status, nextEliminationAt).

Index SpinParticipant(spinId, finalStatus).

Index RoomMember(roomId, membershipStatus).

Transactions for join/leave/start/elimination/winner.

9. Security
Security mechanisms must have a reason.

Area	Required approach
Input validation	Validate REST and Socket.IO payloads.
Authentication	PDF does not define login. NEEDS CLARIFICATION.
Authorization	Owner/admin checks for spin start; membership checks for room state/share.
Room ownership	Only authorized owner/admin starts spin.
WebSocket validation	Do not trust client-supplied state; validate every event.
Injection protection	Parameterized queries / ORM safety.
Rate limiting	Public API and abuse-prone operations. Mechanism NEEDS CLARIFICATION.
Secrets	Environment variables only; never commit secrets.
Error messages	Safe messages only; no stack traces, DB details or secrets.
CORS / HTTP security	Configure for actual deployment; no unrestricted production CORS.
Logging	Redact tokens, secrets and sensitive auth data.
Idempotency	Required for spin start and recommended for mutating operations.
10. Testing Plan
Unit tests:

room service,

spin service,

validation,

authorization,

idempotency.

API integration tests:

create/join/leave/state/share/start/result/health.

WebSocket tests:

connection,

subscription,

event payloads,

reconnect room_state,

duplicate events.

Spin logic tests:

3–20 eligibility,

one active spin,

elimination every 5 seconds,

winner selection,

persistence.

Concurrency tests:

simultaneous join,

simultaneous start,

duplicate start,

user leave during spin,

admin disconnect,

server restart recovery.

Edge-case tests:

insufficient users,

too many users,

unauthorized start,

invalid room,

malformed payloads.

End-to-end tests after frontend/backend integration.

11. Approval
BACKEND STATUS:
CHANGES REQUIRED / NEEDS CLARIFICATION

BLOCKERS:

Exact API paths and request/response schemas.

Authentication mechanism and user identity flow.

Authorization/admin role contract.

WebSocket authentication and subscription contract.

Draft sharing file transfer/hosting contract.

Exact behavior when participant leaves during active spin.

Exact behavior when owner/admin disconnects during active spin.

Exact active-spin recovery after server restart.

Exact timer recovery strategy for delayed timers.

Database technology approval.

API framework, validation library, logging and test library approval.

Cloud and CI/CD configuration ownership.

DEPENDENCIES:

Tech Manager approval of unresolved architecture decisions.

Backend contract approval shared with Frontend.

Frontend plan alignment on REST and Socket.IO payloads.

DevOps input on deployment, environment variables and health/readiness.

QA input on concurrency and edge-case acceptance.

RECOMMENDATIONS:

Approve PostgreSQL, TypeScript, Fastify, Zod, Pino, Jest/Vitest.

Approve a single shared API/event contract document before implementation.

Define Draft sharing as metadata-only unless file upload is explicitly approved.

Define spin departure/admin-disconnect/server-restart rules before coding.

Enforce one active spin via database partial unique index plus transaction.

Use persisted nextEliminationAt for timer recovery.

Require Idempotency-Key for Start Spin.