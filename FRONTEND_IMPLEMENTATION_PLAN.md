# FRONTEND_IMPLEMENTATION_PLAN.md

# Roxstar — Senior Frontend / Client Implementation Plan

**Role:** Senior Frontend / Client Developer — 15+ years experience  
**Source:** Tech Manager requirements for the Roxstar assessment  
**Status:** PLAN ONLY — NO PRODUCTION CODE  
**Gate:** `CHANGES REQUIRED / NEEDS CLARIFICATION`

## 1. Requirements Used

Client-relevant approved requirements:

- Android application using Oboe for local microphone recording.
- Start, Stop and Cancel recording.
- At least one allowed effect: Echo, Reverb or Pitch Shift.
- Local Draft save, list, name, creation time, duration, playback and deletion.
- Create, Join, Leave and Get Room State.
- Participant list and Draft sharing.
- Mandatory events:
  `user_joined`, `user_left`, `draft_shared`, `spin_started`,
  `user_eliminated`, `winner_announced`, `room_state`.
- Reconnect and authoritative state synchronization.
- Spin UI for 3–20 eligible users, owner/admin start, one active spin, 5-second eliminations and final winner.
- Backend is authoritative for room/spin state.
- Client must handle permission failures, network failures, WebSocket disconnect/reconnect, invalid operations, server errors and audio failures.
- Live audio streaming, WebRTC and LiveKit are out of scope.

## 2. Technology

The assessment mandates Android + Oboe but does not approve a specific UI framework, language, state library, HTTP library or local-storage library. Those remain `NEEDS CLARIFICATION`; no dependency will be invented.

| Area | Plan | Status |
|---|---|---|
| Framework | Android | APPROVED |
| Language | TBD | NEEDS CLARIFICATION |
| UI technology | TBD | NEEDS CLARIFICATION |
| State management | Android application state; exact mechanism TBD | NEEDS CLARIFICATION |
| Networking | REST client; exact library TBD | NEEDS CLARIFICATION |
| WebSocket/Socket.IO client | Client matching approved backend | NEEDS CLARIFICATION |
| Audio integration | Native Oboe boundary | APPROVED |
| Local storage | Android local storage; exact mechanism TBD | NEEDS CLARIFICATION |
| Testing | Unit + integration testing | REQUIRED |
| Build system | Android build system | REQUIRED |

No unnecessary SDKs, analytics, authentication libraries or UI dependencies will be added without justification and approval.

## 3. Project Structure

```text
/android-app
├── app/
│   └── src/
│       ├── main/
│       │   ├── <android-source>/
│       │   │   ├── ui/
│       │   │   │   ├── audio/
│       │   │   │   ├── room/
│       │   │   │   ├── spin/
│       │   │   │   └── components/
│       │   │   ├── state/
│       │   │   ├── network/
│       │   │   │   ├── api/
│       │   │   │   └── websocket/
│       │   │   ├── models/
│       │   │   ├── audio/
│       │   │   └── storage/
│       │   └── res/
│       ├── test/
│       └── androidTest/
├── native-audio/
│   └── oboe/
└── README.md
```

Boundary:

```text
UI → Client State → Services
                    ├─ REST
                    ├─ WebSocket
                    ├─ Local Draft Storage
                    └─ Oboe Audio Boundary
```

## 4. UI Screens

### 4.1 Audio / Draft Screen

**Purpose:** Record voice, apply an allowed effect, save Drafts and manage local Drafts.

**Components:** Start, Stop, Cancel, effect selector, Save Draft, Draft list, metadata, Play, Delete, recording/playback status.

**State:** Audio, current recording, selected effect, Drafts, playback.

**API:** None for local Draft operations unless an approved backend contract requires it.

**WebSocket:** None.

**Errors:** Microphone permission, Oboe initialization, recording, file writing, playback and invalid lifecycle.

**Loading:** Audio initialization/processing and asynchronous Draft loading.

**Empty:** No Drafts.

### 4.2 Room Screen

**Purpose:** Create/join/leave a room, view participants and share a Draft.

**Components:** Create, Join, room details, participant list, connection status, Draft selector, Share, Leave, spin section.

**State:** Room, participants, Draft, connection and approved authorization state.

**API:** Create Room, Join Room, Leave Room, Get Room State, Share Draft.

**WebSocket:** `user_joined`, `user_left`, `draft_shared`, `room_state`.

**Errors:** Invalid room, rejected join, leave/share failure, unauthorized operation, server/network failure.

**Loading:** Create, join, state retrieval and sharing.

**Empty:** No other participants; no selected/shared Draft.

### 4.3 Spin Screen / Section

**Purpose:** Display backend-authoritative spin state and result.

**Components:** Eligible users, status, remaining users, eliminations, winner, aborted/error state, Start Spin for authorized user.

**State:** Spin, participants, connection and authorization.

**API:** Start Spin, Get Spin State/Result.

**WebSocket:** `spin_started`, `user_eliminated`, `winner_announced`, `room_state`.

**Errors:** Fewer than 3, more than 20, unauthorized start, active spin, server or connection failure.

**Loading:** Starting/recovering spin.

**Empty:** No active spin / no eligible participants.

## 5. Client State

### Room

```text
roomId
owner/admin identity
room status
participants
shared Draft information
active spin state/reference
```

### Participant

```text
userId
display/profile metadata
membership/presence
eligibility
```

### Draft

```text
draftId
name
creationTime
duration
localFileReference
sharedStatus
```

### Spin

```text
spinId
status
eligibleParticipants
remainingParticipants
eliminatedParticipants
winner
startTime
completionTime
```

### Connection

```text
DISCONNECTED
CONNECTING
CONNECTED
RECONNECTING
```

After reconnect, `room_state` is authoritative and stale local room/spin state is reconciled.

### Audio

```text
IDLE → RECORDING → STOPPING → PROCESSING → SAVED
```

Cancellation and failures must return to a valid state.

## 6. API Integration

Required services:

```text
Create Room
Join Room
Leave Room
Get Room State
Share Draft
Start Spin
Get Spin State / Result
Health / Readiness
```

Client flow:

```text
UI → Client Service → REST → Backend → Response → State → UI
```

The following are blocking and must not be guessed:

- Exact HTTP paths.
- Exact methods where unspecified.
- Request JSON.
- Response JSON.
- Authentication.
- Authorization.
- Error/status contract.
- Idempotency behavior.

### Create Room

Send the approved request and initialize room state from the approved response.

### Join Room

Validate basic client input, send the approved request, initialize state, then establish/recover real-time room state.

### Leave Room

Send the approved leave operation, process the server result, then clear room state and leave the real-time context.

### Get Room State

Use on room entry and after reconnect/state recovery.

### Share Draft

```text
Selected Draft → approved request → backend validation
→ success → draft_shared → room state update
```

The client must never emit an authoritative `draft_shared` event itself.

### Start Spin

The UI can expose Start only to an apparently authorized user, but the backend remains final authority. Rejections must be displayed safely.

### Get Spin State / Result

Use for initial state, recovery, missed-event reconciliation and final result.

### Health / Readiness

Operations/deployment endpoint; do not turn it into unnecessary client polling.

## 7. WebSocket Integration

Connection:

```text
Room context → Connect → approved identity/auth
→ room_state → CONNECTED
```

### `user_joined`

Update participant state from server event. Never emit a duplicate event.

### `user_left`

Update participant/presence state from server event.

### `draft_shared`

Update shared Draft state only after server confirmation.

### `spin_started`

Initialize server-provided spin state and show RUNNING. Do not start an independent authoritative elimination timer.

### `user_eliminated`

Apply supplied elimination and remaining-player state. Never choose an eliminated participant locally.

### `winner_announced`

Store/display supplied winner and mark the UI completed.

### `room_state`

Treat as authoritative. Replace stale room/participant/spin state, especially after reconnect.

## 8. Audio / Oboe Integration Boundary

Do not fake Oboe.

```text
Android UI
  ↓
Audio Controller
  ↓
Native Audio Interface
  ↓
JNI / Native Boundary
  ↓
Oboe
  ↓
Input Stream → Effect Processing → File Writer
  ↓
Local Draft Storage → Playback
```

Android layer owns permission, controls, selected effect, state and user-facing errors.

Native layer owns Oboe stream lifecycle, microphone capture, buffers, effect processing and native audio handling.

No audio is sent through WebSocket/Socket.IO because live audio streaming is outside scope.

## 9. Error Handling

### Permission

`Request → Granted: continue / Denied: explain + retry`

### Network

Show recoverable errors. Do not blindly retry non-idempotent operations.

### WebSocket

```text
CONNECTED → DISCONNECTED → RECONNECTING
→ CONNECTED → room_state recovery
```

Do not fabricate state while disconnected.

### Invalid room

Display safe server rejection; do not expose internals.

### Invalid operation

Handle insufficient/too many users, unauthorized start, active spin, invalid Draft and other server validation failures.

### Server error

Show generic actionable error; never show stack traces, database details or secrets.

### Audio failure

Handle permission, Oboe initialization, stream, file-writing, playback and lifecycle failures without leaving an unrecoverable state.

## 10. Validation

### PDF

The plan preserves Android/Oboe, local audio, Draft lifecycle, room lifecycle, mandatory events, authoritative backend state, spin rules, reconnect and out-of-scope restrictions.

### Tech Manager

The plan follows:

```text
Android
 ├─ Local Oboe audio
 ├─ REST
 └─ WebSocket/Socket.IO
       ↓
 Node.js backend
       ↓
 Database
```

No new product requirement was introduced.

### Backend Contract

**BLOCKED / NEEDS CLARIFICATION**

Required before implementation:

- API paths.
- Request/response schemas.
- Authentication and authorization.
- WebSocket payload schemas.
- WebSocket authentication.
- Error/status contract.
- Idempotency contract.
- Visible UI behavior for spin departure/admin disconnect.
- Server restart and timer recovery behavior.

## 11. Junior Developer Review Rule

For any junior-produced code:

1. Verify the requirement.
2. Compare against this plan.
3. Review architecture boundaries.
4. Check security.
5. Check validation.
6. Check error handling.
7. Check reconnect behavior.
8. Check state consistency.
9. Check tests.
10. Fix or reject incorrect work.
11. Never merge blindly.

Reject code that locally decides the winner/elimination, emits authoritative events, trusts local room state, streams audio over WebSocket, hardcodes secrets, invents API payloads or ignores reconnect recovery.

## 12. Frontend Acceptance Checklist

- [ ] Android platform confirmed.
- [ ] Oboe boundary confirmed.
- [ ] UI technology approved.
- [ ] Language/build configuration approved.
- [ ] State approach approved.
- [ ] REST client approved.
- [ ] Socket.IO/WebSocket client approved.
- [ ] Local Draft storage approved.
- [ ] API paths approved.
- [ ] Request/response schemas approved.
- [ ] Authentication approved.
- [ ] Authorization behavior approved.
- [ ] WebSocket payloads approved.
- [ ] WebSocket authentication approved.
- [ ] Error/status contract approved.
- [ ] Spin departure/reconnect behavior agreed.
- [ ] Server restart/timer recovery understood.
- [ ] Test strategy approved.

## 13. STATUS

# `CHANGES REQUIRED`

Production implementation must **not** begin yet.

Blocking decisions are the unresolved client technology choices, exact backend API/WebSocket contracts, authentication/authorization contracts, and spin edge-case behaviors that affect client UI/state.

Implementation gate:

```text
TECH MANAGER
    ↓
Approve unresolved architecture decisions
    ↓
BACKEND DEVELOPER
    ↓
Provide API + WebSocket contracts
    ↓
TECH MANAGER
    ↓
Approve contracts
    ↓
SENIOR FRONTEND / CLIENT
    ↓
Approve this plan
    ↓
IMPLEMENTATION
```

## Final Frontend Principle

```text
REQUIREMENT
    ↓
VERIFY
    ↓
IDENTIFY DEPENDENCIES
    ↓
WAIT FOR APPROVED CONTRACT
    ↓
DESIGN STATE
    ↓
IMPLEMENT
    ↓
TEST
    ↓
REVIEW
    ↓
INTEGRATE
```

**No blind implementation.**
