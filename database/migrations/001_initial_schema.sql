-- 001_initial_schema.sql
-- Roxstar core schema.
--
-- Design notes (see TECH_MANAGER_DECISIONS.md D3, D9, D11, D14):
--   * Status columns are TEXT + CHECK rather than native ENUMs so that adding a
--     state is an ordinary migration instead of an ALTER TYPE that locks readers.
--   * Every rule the spin engine depends on is enforced by the database, not only
--     by application code, so a bug in a service cannot corrupt a spin.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- User: anonymous, device-bound identity (D8). No credentials, no PII.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
    device_id    TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One identity per device: re-authenticating from the same handset returns
    -- the same user instead of silently creating a duplicate participant.
    CONSTRAINT users_device_id_key UNIQUE (device_id)
);

-- ---------------------------------------------------------------------------
-- Room
-- ---------------------------------------------------------------------------
CREATE TABLE rooms (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code       TEXT        NOT NULL,
    name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    owner_id   UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    status     TEXT        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Short join code so a second demo client can join without copying a UUID.
    CONSTRAINT rooms_code_key UNIQUE (code)
);

CREATE INDEX rooms_owner_id_idx ON rooms (owner_id);

-- ---------------------------------------------------------------------------
-- RoomMember: membership + presence.
--
-- membership_status and connection_status are deliberately separate (D13):
-- a dropped socket is NOT a departure until the grace period expires.
-- ---------------------------------------------------------------------------
CREATE TABLE room_members (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id           UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id           UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role              TEXT        NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
    membership_status TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (membership_status IN ('ACTIVE', 'LEFT')),
    connection_status TEXT        NOT NULL DEFAULT 'DISCONNECTED' CHECK (connection_status IN ('CONNECTED', 'DISCONNECTED')),
    joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at           TIMESTAMPTZ,
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    disconnected_at   TIMESTAMPTZ,

    -- Makes a duplicate join a no-op at the storage layer, so two simultaneous
    -- join requests cannot create two memberships (concurrency case 1).
    CONSTRAINT room_members_room_user_key UNIQUE (room_id, user_id)
);

CREATE INDEX room_members_room_status_idx ON room_members (room_id, membership_status);
CREATE INDEX room_members_user_idx        ON room_members (user_id);
-- Drives the presence sweeper that expires the disconnect grace period.
CREATE INDEX room_members_disconnected_idx
    ON room_members (disconnected_at)
    WHERE connection_status = 'DISCONNECTED' AND membership_status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Draft: metadata only (D10). Audio bytes never leave the device.
-- hosted_file_url is accepted and stored but nothing is uploaded here.
-- ---------------------------------------------------------------------------
CREATE TABLE drafts (
    id              UUID PRIMARY KEY,
    owner_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name            TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    duration_ms     INTEGER     NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 3600000),
    effect          TEXT        NOT NULL DEFAULT 'NONE' CHECK (effect IN ('NONE', 'ECHO', 'REVERB', 'PITCH_SHIFT')),
    hosted_file_url TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX drafts_owner_idx ON drafts (owner_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Draft sharing history. Kept as an append-only log rather than a column on
-- rooms so "what was shared, by whom, when" survives the next share.
-- ---------------------------------------------------------------------------
CREATE TABLE room_shared_drafts (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id   UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    draft_id  UUID        NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
    shared_by UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    shared_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX room_shared_drafts_room_idx ON room_shared_drafts (room_id, shared_at DESC);

-- ---------------------------------------------------------------------------
-- Spin
--
-- next_elimination_at is the authoritative timer (D14). It lives in the
-- database, not in a setInterval, so a restarted process resumes a running
-- spin on its first scheduler tick with no recovery routine.
-- ---------------------------------------------------------------------------
CREATE TABLE spins (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id                 UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    status                  TEXT        NOT NULL DEFAULT 'WAITING'
                                        CHECK (status IN ('WAITING', 'RUNNING', 'COMPLETED', 'ABORTED')),
    started_by              UUID        REFERENCES users (id) ON DELETE SET NULL,
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    winner_user_id          UUID        REFERENCES users (id) ON DELETE SET NULL,
    next_elimination_at     TIMESTAMPTZ,
    elimination_interval_ms INTEGER     NOT NULL DEFAULT 5000 CHECK (elimination_interval_ms > 0),
    abort_reason            TEXT        CHECK (abort_reason IN ('NO_PARTICIPANTS', 'ROOM_CLOSED', 'MANUAL')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A completed spin must have a winner; an aborted spin must not.
    CONSTRAINT spins_completed_has_winner
        CHECK (status <> 'COMPLETED' OR (winner_user_id IS NOT NULL AND completed_at IS NOT NULL)),
    CONSTRAINT spins_aborted_has_reason
        CHECK (status <> 'ABORTED' OR abort_reason IS NOT NULL),
    -- A running spin must have a deadline, or the scheduler could never tick it.
    CONSTRAINT spins_running_has_deadline
        CHECK (status <> 'RUNNING' OR next_elimination_at IS NOT NULL)
);

-- THE rule: "Only one active spin may exist in a room."
-- Enforced by the database, so two concurrent start requests cannot both win
-- however the application layer is refactored (concurrency case 2).
CREATE UNIQUE INDEX spins_one_active_per_room_idx
    ON spins (room_id)
    WHERE status = 'RUNNING';

-- Drives the scheduler's "which spins are due?" query.
CREATE INDEX spins_due_idx ON spins (next_elimination_at) WHERE status = 'RUNNING';
CREATE INDEX spins_room_created_idx ON spins (room_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- SpinParticipant: eligibility snapshot taken at start time.
--
-- The roster is frozen when the spin starts. Someone joining the room mid-spin
-- is a spectator, not a late entrant -- otherwise "3-20 eligible users" would
-- be unverifiable at any single moment.
-- ---------------------------------------------------------------------------
CREATE TABLE spin_participants (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spin_id           UUID        NOT NULL REFERENCES spins (id) ON DELETE CASCADE,
    user_id           UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    eligible          BOOLEAN     NOT NULL DEFAULT TRUE,
    elimination_order INTEGER,
    eliminated_at     TIMESTAMPTZ,
    final_status      TEXT        NOT NULL DEFAULT 'ACTIVE'
                                  CHECK (final_status IN ('ACTIVE', 'ELIMINATED', 'LEFT', 'WINNER')),

    CONSTRAINT spin_participants_spin_user_key UNIQUE (spin_id, user_id),
    -- Elimination order is dense and unique within a spin, so the event log can
    -- be replayed in exactly the order the users saw.
    CONSTRAINT spin_participants_order_key UNIQUE (spin_id, elimination_order),
    CONSTRAINT spin_participants_eliminated_has_order
        CHECK (final_status NOT IN ('ELIMINATED', 'LEFT') OR elimination_order IS NOT NULL)
);

CREATE INDEX spin_participants_spin_status_idx ON spin_participants (spin_id, final_status);
CREATE INDEX spin_participants_user_idx        ON spin_participants (user_id);

-- ---------------------------------------------------------------------------
-- SpinEvent: append-only audit log.
--
-- Written inside the same transaction as the state change and BEFORE the
-- broadcast, so a crash can never produce an event clients saw but the
-- database does not record. `seq` gives clients a total order.
-- ---------------------------------------------------------------------------
CREATE TABLE spin_events (
    seq        BIGSERIAL PRIMARY KEY,
    event_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
    spin_id    UUID        NOT NULL REFERENCES spins (id) ON DELETE CASCADE,
    room_id    UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    event_type TEXT        NOT NULL CHECK (event_type IN ('spin_started', 'user_eliminated', 'winner_announced', 'spin_aborted')),
    payload    JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Client-side dedupe key (D17) must be globally unique.
    CONSTRAINT spin_events_event_id_key UNIQUE (event_id)
);

CREATE INDEX spin_events_spin_seq_idx ON spin_events (spin_id, seq);
CREATE INDEX spin_events_room_idx     ON spin_events (room_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Idempotency (D18). Scoped per user+endpoint so one client's key cannot
-- collide with, or read back, another client's response.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key             TEXT        NOT NULL,
    user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint        TEXT        NOT NULL,
    request_hash    TEXT        NOT NULL,
    response_status INTEGER     NOT NULL,
    response_body   JSONB       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT idempotency_keys_scope_key UNIQUE (key, user_id, endpoint)
);

-- Supports the 24h TTL sweep.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
