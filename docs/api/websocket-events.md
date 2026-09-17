# WebSocket event contract

**Namespace:** `/rooms` · **Path:** `/socket.io` · **Transport:** WebSocket

This is the frozen real-time contract, the counterpart to
[`openapi.yaml`](./openapi.yaml). The Android client (`RoomSocket.kt`) and the
backend (`backend/src/websocket/`) are both written against it.

---

## Connecting

```
client                                  server
  |                                        |
  |-- connect, auth: { token } ----------->|
  |                                        | verify HS256, resolve user
  |<-- connect ----------------------------|  or  connect_error: UNAUTHENTICATED
  |                                        |
  |-- subscribe_room { roomId } ---------->|
  |                                        | verify ACTIVE membership
  |<-- ack { ok: true } -------------------|
  |<-- room_state -------------------------|
  |                                        |
```

The handshake carries the same bearer token as REST, in `auth.token`. A
connection without a valid token is refused with `connect_error`
`UNAUTHENTICATED` — deliberately opaque, so a client cannot learn whether a
token was absent, forged or expired.

**This is also the reconnect sequence.** There is one code path, not two: on
reconnect the client re-emits `subscribe_room` and receives a fresh
`room_state`. That removes the "does the server push or does the client ask?"
ambiguity that the integration audit flagged.

---

## Client → server

The client can do exactly two things. It may **never** assert presence,
membership, spin state or an elimination — the backend is authoritative, and
that has to be enforced by the protocol, not by convention.

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `subscribe_room` | `{ roomId: uuid }` | `{ ok: true, roomId }` or `{ ok: false, error: { code, message } }` | Membership is re-checked server-side. A socket that guessed a room id receives nothing. |
| `unsubscribe_room` | `{ roomId: uuid }` | `{ ok: true }` | Leaves the fan-out channel; does **not** leave the room. |

---

## Server → client

### Common envelope

Every broadcast carries:

```jsonc
{
  "eventId":   "9f1c...",              // UUID v4 — the dedupe key
  "occurredAt":"2026-01-01T12:00:05.000Z",
  "roomId":    "8a2f...",
  "seq":       "1043"                  // spin events only; BIGSERIAL, total order
}
```

**Clients must deduplicate on `eventId`.** A reconnect can redeliver an event,
and showing the same elimination twice is a visible bug. The Android client
keeps a bounded window of the last 256 ids (`RoomSocket.seenEventIds`).

`seq` appears only on spin events, where it comes from the `spin_events`
primary key. It gives a total order a client can use to detect a gap after a
reconnect. Room-membership events have no `seq` because they have no audit row.

**Events are persisted before they are broadcast.** A client can therefore never
observe an event the database does not record.

---

### `room_state`

The authoritative snapshot. **It supersedes everything.**

Emitted on subscribe, on reconnect, and whenever presence changes without
membership changing.

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...",
  "room":         { /* Room */ },
  "participants": [ /* Participant[] */ ],
  "sharedDraft":  { /* SharedDraft */ } | null,
  "activeSpin":   { /* Spin */ } | null,
  "lastSpin":     { /* Spin */ } | null
}
```

Shape is identical to `GET /api/v1/rooms/{roomId}/state` — one builder produces
both, so REST and real-time cannot drift.

> **Client rule:** replace local state, do not merge. Merging is how two clients
> end up disagreeing about who is still in.

A presence change (someone's socket dropped or came back) is reported as
`room_state` rather than a synthetic event. Emitting `user_joined` on a
reconnect would be a duplicate join, which the client contract forbids.

---

### `user_joined`

A new member joined the room.

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...",
  "participant":  { /* Participant */ },
  "participants": [ /* the full updated list */ ]
}
```

Broadcast **only on a first join**. A duplicate join is a no-op and emits
nothing, because clients would otherwise render the same participant twice.

---

### `user_left`

A member left the room.

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...",
  "userId":  "...",
  "reason":  "EXPLICIT" | "DISCONNECT_TIMEOUT",
  "participants": [ /* the full updated list */ ]
}
```

| `reason` | Meaning |
|---|---|
| `EXPLICIT` | The user called `POST /leave`. Immediate. |
| `DISCONNECT_TIMEOUT` | Their socket dropped and the 15-second grace period expired. |

A dropped socket does **not** emit this immediately. Mobile networks drop
constantly, and because leaving forfeits a spin seat, instant removal would
knock players out for a two-second tunnel. During the grace period the member
stays in the list with `connectionStatus: "DISCONNECTED"`, and the change
arrives as `room_state`.

If a spin is running when this fires, a `user_eliminated` with
`reason: "LEFT"` follows.

---

### `draft_shared`

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...",
  "sharedDraft": {
    "draft":    { "draftId": "...", "name": "Take 3", "durationMs": 12000,
                  "effect": "ECHO", "hostedFileUrl": null, "ownerId": "...",
                  "createdAt": "..." },
    "sharedBy": "...",
    "sharedAt": "..."
  }
}
```

**Metadata only.** No audio travels over this transport — live audio streaming
is out of scope, and the e2e suite asserts that no payload contains base64 or
PCM data.

The client must never emit this itself; it follows a successful
`POST /rooms/{roomId}/drafts/share`.

---

### `spin_started`

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...", "seq": "1041",
  "spin": { /* Spin, status: "RUNNING" */ }
}
```

Carries the frozen roster of eligible players and the initial sequence state.

> **Client rule:** render `spin`. Do **not** start an independent elimination
> timer. The server owns the clock; a local one would drift and then disagree.

---

### `user_eliminated`

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...", "seq": "1042",
  "spinId": "...",
  "eliminatedUserId": "...",
  "eliminatedDisplayName": "Sam",
  "eliminationOrder": 1,
  "reason": "SPIN" | "LEFT",
  "remainingParticipants": [ /* SpinParticipant[] */ ],
  "spin": { /* the full updated Spin */ }
}
```

| `reason` | Meaning |
|---|---|
| `SPIN` | Drawn by the wheel on a scheduled tick. |
| `LEFT` | Forfeited by leaving the room mid-spin. |

The distinction exists so the UI can say "Sam forfeited by leaving" rather than
"Sam was eliminated" when their phone died. `eliminationOrder` is 1-based and
dense across both kinds.

> **Client rule:** never choose the eliminated participant locally.

---

### `winner_announced`

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...", "seq": "1043",
  "spinId": "...",
  "winner": { "userId": "...", "displayName": "Ada" },
  "spin":   { /* Spin, status: "COMPLETED" */ }
}
```

Emitted when exactly one participant remains. It arrives in the **same tick** as
the final elimination, so clients never sit on a one-player wheel waiting five
seconds for nothing. The result is persisted before this is sent.

---

### `spin_aborted`

```jsonc
{
  "eventId": "...", "occurredAt": "...", "roomId": "...", "seq": "1044",
  "spinId": "...",
  "reason": "NO_PARTICIPANTS" | "ROOM_CLOSED" | "MANUAL",
  "spin":   { /* Spin, status: "ABORTED" */ }
}
```

**Not one of the PDF's seven mandatory events.** It was added because the
forfeit-on-leave rule can end a spin with nobody left, and leaving clients on a
`RUNNING` screen forever would be worse than one honest extra event. It is
purely additive — no mandatory event changed shape to accommodate it.

---

## Ordering guarantees

Within one spin, events are emitted in `seq` order and `seq` is monotonic:

```
spin_started → user_eliminated (1) → user_eliminated (2) → … → winner_announced
```

Socket.IO preserves order on a single connection, so a connected client sees
them in that order. Across a reconnect, ordering is **not** guaranteed and
events may be missed entirely — which is what `room_state` is for.

## Client checklist

- [x] Dedupe on `eventId`
- [x] Treat `room_state` as authoritative; replace rather than merge
- [x] Re-emit `subscribe_room` after every reconnect
- [x] Never emit an authoritative event
- [x] Never run a local elimination timer or pick a winner
- [x] Render `reason` (`SPIN` vs `LEFT`, `EXPLICIT` vs `DISCONNECT_TIMEOUT`) rather than inferring it
- [x] Show `connectionStatus: DISCONNECTED` as "reconnecting", not as "gone"
