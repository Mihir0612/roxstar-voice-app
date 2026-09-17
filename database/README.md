# Database

PostgreSQL 16. Schema, migrations and the reasoning behind both.

## Why PostgreSQL

The assessment allows PostgreSQL, MySQL or MongoDB. The spin rules decided it:

| Rule | What it needs |
|---|---|
| "Only one active spin may exist in a room" | A **partial unique index** — `UNIQUE (room_id) WHERE status='RUNNING'` |
| Two concurrent starts must not both win | `SELECT … FOR UPDATE` on the room row |
| A restarted server must resume a spin | `FOR UPDATE SKIP LOCKED` to claim work without blocking |
| An elimination must be atomic across three tables | Real transactions |

Postgres expresses all four directly. MySQL has no partial indexes (the usual
workaround is a nullable generated column, which is a workaround). MongoDB can
model it with a partial index too, but the elimination path is a multi-document
transaction with row-level locking, which is where its story gets weaker.

Those invariants live in the **database**, not only in application code, so a
refactor of a service cannot corrupt a spin.

## Migrations

Ordered `NNN_name.sql` files, applied by `backend/src/db/migrate.ts`.

```bash
cd backend && npm run migrate
```

| Property | How |
|---|---|
| Ordered | Lexicographic filename sort |
| Tracked | `schema_migrations` table |
| Atomic | One transaction per file; a failure leaves no partial schema |
| Concurrency-safe | `pg_advisory_lock` — CI and a starting Cloud Run revision can race safely |
| Idempotent | Applied files are skipped |
| Runs at boot | So a revision never serves against an older schema |

### Files

| File | Contents |
|---|---|
| `001_initial_schema.sql` | All 9 tables, constraints, indexes |
| `002_updated_at_triggers.sql` | `updated_at` maintained by trigger, not by each repository method |

### Adding one

Create `003_your_change.sql`. Migrations here are **additive** — rollback on
Cloud Run is a traffic switch to the previous revision, which does not revert
schema. A destructive change needs a paired down-migration and a deliberate
plan, not a `DROP COLUMN` in an ordinary release.

## Schema

See `docs/architecture/README.md` §5 for the ER diagram.

| Table | Purpose |
|---|---|
| `users` | Anonymous device-bound identity. No PII, no credentials. |
| `rooms` | Owner, status, short join code |
| `room_members` | Membership **and** presence, kept separate on purpose |
| `drafts` | Recording metadata. Audio stays on the device. |
| `room_shared_drafts` | Append-only share history |
| `spins` | Status, timestamps, winner, and the authoritative deadline |
| `spin_participants` | Frozen roster, elimination order, final status |
| `spin_events` | Append-only audit log, written before any broadcast |
| `idempotency_keys` | Stored responses for replay, scoped per user+endpoint |

### Three decisions worth explaining

**`membership_status` and `connection_status` are separate columns.** A dropped
socket is not a departure. Mobile networks drop constantly, and because leaving
forfeits a spin seat, collapsing these into one field would knock players out of
spins for a two-second tunnel. `disconnected_at` drives a 15-second grace period
before a disconnect becomes a departure.

**`spins.next_elimination_at` is the clock.** Not a `setInterval` in the Node
process. The scheduler polls the database for due spins, so a restarted process
resumes a running spin on its first tick with no recovery routine — and no
recovery routine that can itself be buggy.

**`spin_participants` freezes the roster at start.** Someone joining mid-spin is
a spectator. This is the only reading under which "3–20 eligible users" is
verifiable at a single moment.

### Constraints that carry business rules

```sql
-- Only one active spin per room. THE rule, enforced by storage.
CREATE UNIQUE INDEX spins_one_active_per_room_idx
    ON spins (room_id) WHERE status = 'RUNNING';

-- A duplicate join cannot create a second membership.
CONSTRAINT room_members_room_user_key UNIQUE (room_id, user_id)

-- Elimination order is dense and unique, so the log replays exactly as seen.
CONSTRAINT spin_participants_order_key UNIQUE (spin_id, elimination_order)

-- A completed spin has a winner; an aborted one has a reason.
CHECK (status <> 'COMPLETED' OR (winner_user_id IS NOT NULL AND completed_at IS NOT NULL))
CHECK (status <> 'ABORTED'   OR abort_reason IS NOT NULL)

-- A running spin has a deadline, or the scheduler could never tick it.
CHECK (status <> 'RUNNING' OR next_elimination_at IS NOT NULL)

-- The client dedupe key must be globally unique.
CONSTRAINT spin_events_event_id_key UNIQUE (event_id)
```

### Indexes and the query each serves

| Index | Query |
|---|---|
| `spins(next_elimination_at) WHERE status='RUNNING'` | The scheduler, every 500 ms |
| `room_members(room_id, membership_status)` | Participant list, eligibility count |
| `room_members(disconnected_at) WHERE DISCONNECTED AND ACTIVE` | The presence sweeper |
| `spin_participants(spin_id, final_status)` | "who is still active?", every tick |
| `spin_events(spin_id, seq)` | Ordered replay |
| `room_shared_drafts(room_id, shared_at DESC)` | Latest shared draft for `room_state` |
| `drafts(owner_id, created_at DESC)` | A user's draft list |

No index was added speculatively; each maps to a query in the code.

## Local development

```bash
docker compose up -d postgres
cd backend
DATABASE_URL=postgres://roxstar:roxstar_local_dev@localhost:5433/roxstar npm run migrate
```

Port **5433** on the host, to avoid colliding with a local Postgres on 5432.

## Known limitations

**`spin_events` has no retention policy.** It is the audit trail proving the spin
sequence was correct, and growth is negligible at assessment scale. In
production it would need one:

```sql
DELETE FROM spin_events
 WHERE created_at < now() - INTERVAL '90 days'
   AND spin_id IN (SELECT id FROM spins WHERE status IN ('COMPLETED','ABORTED'));
```

**`idempotency_keys` is swept hourly** with a 24-hour TTL, by a background
worker — not left to grow.

**No read replica or partitioning.** Neither is warranted for this workload, and
adding them would be complexity without a requirement.
