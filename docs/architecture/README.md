# Architecture

All diagrams are Mermaid, so they render on GitHub and stay diffable — a PNG
would go stale the first time the code changed and nobody would notice.

---

## 1. System architecture

```mermaid
flowchart TB
    subgraph Device["Android device"]
        UI["Compose UI<br/>Studio · Room · Spin"]
        VM["ViewModels<br/>StateFlow"]
        REPO["RoxstarRepository"]
        SOCK["RoomSocket<br/>Socket.IO client"]
        ROOMDB[("Room DB<br/>draft metadata")]
        BRIDGE["NativeAudioBridge<br/>JNI"]
        ENGINE["AudioEngine C++<br/>Oboe"]
        WAV[("Local WAV files")]

        UI --> VM --> REPO
        VM --> SOCK
        REPO --> ROOMDB
        VM --> BRIDGE --> ENGINE --> WAV
    end

    subgraph Cloud["Google Cloud"]
        subgraph Run["Cloud Run · 1 instance · session affinity"]
            REST["Fastify REST<br/>/api/v1"]
            WS["Socket.IO<br/>/rooms"]
            SVC["Services<br/>room · draft · spin · presence"]
            SCHED["Scheduler<br/>polls the DB every 500ms"]
        end
        SQL[("Cloud SQL<br/>PostgreSQL 16")]
        SECRETS["Secret Manager<br/>DATABASE_URL · AUTH_SECRET"]

        REST --> SVC
        WS --> SVC
        SCHED --> SVC
        SVC --> SQL
        SECRETS -.injected at start.-> Run
    end

    REPO -- "HTTPS · bearer token" --> REST
    SOCK -- "WSS · token in handshake" --> WS

    style WAV fill:#2ED3A6,color:#000
    style SQL fill:#E5197F,color:#fff
    style SCHED fill:#FFB020,color:#000
```

**The two boundaries that matter:**

1. **Audio is local.** The WAV never crosses the network. Sharing a draft sends
   name, duration and effect — nothing else. Live audio streaming is out of
   scope, and the end-to-end suite asserts no event payload contains audio data.

2. **The backend is authoritative.** The client renders spin state; it never
   computes it. No local elimination timer, no local winner.

---

## 2. Audio flow

```mermaid
flowchart LR
    MIC(["Microphone"]) --> OBOE["Oboe input stream<br/>AAudio · LowLatency · Exclusive<br/>48kHz mono float"]
    OBOE --> CB["onAudioReady<br/><b>real-time thread</b>"]

    subgraph RT["Real-time: no allocation, no locks, no I/O"]
        CB --> FX["Effect.process in place<br/>Echo · Reverb · Pitch Shift"]
        FX --> LVL["peak level → UI meter"]
        FX --> FIFO["bounded FIFO<br/>try_lock, drop on contention"]
    end

    FIFO --> WRITER["Writer thread"]
    WRITER --> PCM["float → int16, clamped"]
    PCM --> FILE[("WAV file<br/>filesDir/recordings")]
    FILE --> PLAY["MediaPlayer playback"]
    FILE -. "name, duration, effect only" .-> SHARE["POST /drafts/share"]

    style RT fill:#FFB020,color:#000
    style FILE fill:#2ED3A6,color:#000
```

**Why the writer thread exists.** `fwrite` can block on flash for tens of
milliseconds — far longer than an audio callback deadline. Writing inline is the
classic cause of dropouts, so the callback copies the buffer into a bounded
queue and returns. If the queue is full or the writer holds the lock, the buffer
is dropped: losing one buffer is bad, but blocking the audio thread would glitch
every buffer after it too.

**Effects allocate once**, in `prepare()`, off the audio thread. `process()` only
indexes into buffers that already exist.

### Echo

```
out[n]       = in[n] + feedback · delayLine[n − D]
delayLine[n] = out[n]          ← the mixed signal, not the dry input
```

Feeding the *output* back is what makes the echo repeat and decay rather than
produce a single slap. Each repeat is `feedback` times quieter, so the tail
converges geometrically. Verified by measurement, not inspection: an impulse in,
and the repeats are checked to land one delay period apart at `feedback` and
`feedback²`.

### Pitch shift

Time-domain granular resampling. The read pointer sits `delay` samples behind
the write head, and that delay **ramps** by `1 − pitchRatio` per output frame,
so the read head advances `pitchRatio` input samples per output sample. Two
heads run half a grain apart under complementary periodic Hann windows, which
sum to unity and hide the wrap discontinuity.

> The first version of this ramped the read *position* by `pitchRatio` instead
> of the *delay* by `1 − pitchRatio`. It looked right and reviewed fine. The
> host-side test measured a 440 Hz tone coming out at 440 Hz for a +12-semitone
> shift and 7.8 Hz for a no-op shift. See `native-audio/tests/`.

---

## 3. Room and WebSocket event flow

```mermaid
sequenceDiagram
    autonumber
    participant A as Owner
    participant B as Member B
    participant API as REST
    participant WS as Socket.IO
    participant DB as PostgreSQL

    A->>API: POST /auth/session
    API->>DB: upsert user by deviceId
    API-->>A: token

    A->>API: POST /rooms
    API->>DB: insert room + OWNER membership (txn)
    API-->>A: room + join code

    A->>WS: connect(token) → subscribe_room
    WS->>DB: verify ACTIVE membership
    WS-->>A: room_state

    B->>API: POST /rooms/{code}/join
    API->>DB: upsert membership (unique roomId,userId)
    API-->>B: room + full snapshot
    WS-->>A: user_joined
    B->>WS: connect → subscribe_room
    WS-->>B: room_state

    A->>API: POST /rooms/{id}/drafts/share
    Note over A,API: metadata only — the WAV stays on the device
    API->>DB: upsert draft + record share (txn)
    WS-->>A: draft_shared
    WS-->>B: draft_shared

    Note over B: socket drops
    WS->>DB: connection_status = DISCONNECTED
    WS-->>A: room_state (B shown as reconnecting)
    Note over B,DB: 15s grace period — B is NOT removed
    B->>WS: reconnect → subscribe_room
    WS-->>B: room_state (everything missed, in one payload)
```

---

## 4. Spin state machine

```mermaid
stateDiagram-v2
    [*] --> WAITING

    WAITING --> RUNNING: start_spin<br/>owner/admin · 3–20 players · none running
    WAITING --> WAITING: rejected<br/>409 with the reason

    RUNNING --> RUNNING: tick<br/>eliminate 1, advance deadline
    RUNNING --> RUNNING: participant leaves<br/>forfeit, order assigned
    RUNNING --> COMPLETED: one remains<br/>winner persisted, then broadcast
    RUNNING --> ABORTED: nobody remains<br/>NO_PARTICIPANTS

    COMPLETED --> [*]
    ABORTED --> [*]

    note right of RUNNING
        next_elimination_at lives on the row.
        The scheduler polls the DB — it owns no state.
        A restarted process resumes on its first tick.
    end note
```

### One elimination tick

```mermaid
flowchart TD
    START["scheduler tick · every 500ms"] --> FIND["SELECT id FROM spins<br/>WHERE status='RUNNING'<br/>AND next_elimination_at <= now()"]
    FIND --> CLAIM{"claim with<br/>FOR UPDATE SKIP LOCKED"}
    CLAIM -->|"held by another worker"| SKIP["skip — no double elimination"]
    CLAIM -->|"claimed"| TXN

    subgraph TXN["one transaction"]
        LOCK["lock active participants FOR UPDATE"] --> COUNT{"how many active?"}
        COUNT -->|0| ABORT["ABORTED · NO_PARTICIPANTS"]
        COUNT -->|1| WIN1["declare winner"]
        COUNT -->|"2+"| PICK["crypto.randomInt draw"]
        PICK --> MARK["mark ELIMINATED, assign order"]
        MARK --> EV1["append spin_events row"]
        EV1 --> REM{"1 left?"}
        REM -->|yes| WIN2["declare winner in the same tick"]
        REM -->|no| NEXT["next_elimination_at += 5s<br/>(re-anchor if > 15s behind)"]
    end

    TXN --> COMMIT["COMMIT"]
    COMMIT --> CAST["broadcast — only after commit"]

    style TXN fill:#FFB020,color:#000
    style CAST fill:#2ED3A6,color:#000
```

**Three properties this buys:**

- **No double elimination.** `SKIP LOCKED` means a slow tick is skipped, never
  duplicated. Ten concurrent tick attempts per round still produce exactly N−1
  eliminations — asserted in the concurrency suite.
- **No event without state.** The audit row commits with the state change, and
  the broadcast happens after. A crash can lose a broadcast; it cannot produce
  one the database does not record.
- **Restart is a non-event.** There is no recovery routine to get wrong — a
  fresh process finds `RUNNING` spins on its first ordinary tick.

---

## 5. Database schema

```mermaid
erDiagram
    users ||--o{ rooms : owns
    users ||--o{ room_members : "is"
    users ||--o{ drafts : records
    users ||--o{ spin_participants : plays
    rooms ||--o{ room_members : has
    rooms ||--o{ room_shared_drafts : receives
    rooms ||--o{ spins : hosts
    drafts ||--o{ room_shared_drafts : "shared as"
    spins ||--o{ spin_participants : includes
    spins ||--o{ spin_events : logs

    users {
        uuid id PK
        text display_name
        text device_id UK "one identity per device"
        timestamptz created_at
    }
    rooms {
        uuid id PK
        text code UK "6-char join code"
        uuid owner_id FK
        text status "OPEN | CLOSED"
    }
    room_members {
        uuid id PK
        uuid room_id FK
        uuid user_id FK
        text role "OWNER | ADMIN | MEMBER"
        text membership_status "ACTIVE | LEFT"
        text connection_status "CONNECTED | DISCONNECTED"
        timestamptz disconnected_at "drives the grace period"
    }
    drafts {
        uuid id PK "minted on the device"
        uuid owner_id FK
        int duration_ms
        text effect
        text hosted_file_url "nullable — nothing is hosted"
    }
    spins {
        uuid id PK
        uuid room_id FK
        text status "WAITING|RUNNING|COMPLETED|ABORTED"
        uuid winner_user_id FK
        timestamptz next_elimination_at "the authoritative clock"
        int elimination_interval_ms
    }
    spin_participants {
        uuid id PK
        uuid spin_id FK
        uuid user_id FK
        int elimination_order "dense, unique per spin"
        text final_status "ACTIVE|ELIMINATED|LEFT|WINNER"
    }
    spin_events {
        bigserial seq PK "total order for clients"
        uuid event_id UK "client dedupe key"
        text event_type
        jsonb payload
    }
```

### Constraints that carry business rules

| Rule | Enforced by |
|---|---|
| One active spin per room | `CREATE UNIQUE INDEX ... ON spins(room_id) WHERE status='RUNNING'` |
| No duplicate membership | `UNIQUE (room_id, user_id)` |
| One identity per device | `UNIQUE (device_id)` |
| Dense, unique elimination order | `UNIQUE (spin_id, elimination_order)` |
| A completed spin has a winner | `CHECK (status <> 'COMPLETED' OR winner_user_id IS NOT NULL)` |
| A running spin has a deadline | `CHECK (status <> 'RUNNING' OR next_elimination_at IS NOT NULL)` |
| Client dedupe keys are unique | `UNIQUE (event_id)` |

These live in the database rather than only in application code, so a
refactor of a service cannot corrupt a spin. The partial unique index in
particular is what makes "only one active spin" true under concurrency — the
row lock in `startSpin` is the fast path, and the index is the guarantee.

### Indexes and why

| Index | Serves |
|---|---|
| `spins(next_elimination_at) WHERE status='RUNNING'` | The scheduler's hot query, every 500 ms |
| `room_members(room_id, membership_status)` | Participant list and eligibility count |
| `room_members(disconnected_at) WHERE DISCONNECTED AND ACTIVE` | The presence sweeper |
| `spin_participants(spin_id, final_status)` | "who is still active?" on every tick |
| `spin_events(spin_id, seq)` | Ordered replay of a spin |
| `room_shared_drafts(room_id, shared_at DESC)` | Latest shared draft for `room_state` |
