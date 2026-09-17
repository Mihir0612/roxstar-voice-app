# TECH_MANAGER_DECISIONS.md

**Role:** Tech Manager
**Purpose:** Close every `NEEDS CLARIFICATION` item raised by the Frontend, Backend, Full Stack and DevOps plans so implementation can begin.
**Inputs:** Roxstar assessment PDF (source of truth), `TECH_MANAGER_REQUIREMENTS.md` §16, `BACKEND_IMPLEMENTATION_PLAN.md` §11, `FRONTEND_IMPLEMENTATION_PLAN.md` §13, `FULLSTACK_IMPLEMENTATION_PLAN.txt` (INTEGRATION_CONTRACT §6), `DEVOPS_IMPLEMENTATION_PLAN.txt` §12.

> **Rule applied:** a decision is recorded only where the PDF is silent on *implementation detail*. No decision below adds, removes or reinterprets a product requirement. Where the PDF is explicit (3–20 users, 5-second eliminations, one active spin, owner/admin start, last-one-standing, persisted result, out-of-scope list), the PDF wins and no decision was needed.

---

## Decision register

| # | Open item | Decision | Rationale | Reversible? |
|---|---|---|---|---|
| D1 | Backend language | **TypeScript** on Node.js 22 LTS | Compile-time enforcement of the event/DTO contract that Full Stack flagged as the top integration risk. | Yes (cost: high) |
| D2 | API framework | **Fastify 5** | Native schema validation hooks, first-class Pino logging, low overhead, clean plugin boundary for CORS / rate-limit / auth. | Yes |
| D3 | Database | **PostgreSQL 16** | The spin rules need *database-enforced* invariants: partial unique index for "one active spin", `SELECT … FOR UPDATE` for elimination ticks, `FOR UPDATE SKIP LOCKED` for crash-safe timer claiming, real transactions. MongoDB cannot express these as cheaply. | No (schema-bound) |
| D4 | DB access layer | **`pg` driver + parameterized SQL + in-repo migration runner** | No ORM: the spin engine relies on explicit lock semantics that ORMs obscure. Parameterized queries satisfy the injection-protection requirement. | Yes |
| D5 | Validation | **Zod** at every transport boundary (REST body/params/query, Socket.IO payloads) | One schema source, inferred TS types, safe error mapping. | Yes |
| D6 | Logging | **Pino**, JSON to stdout, `redact` list for `authorization`, `token`, `password`, `DATABASE_URL` | Container-native; Cloud Run ingests stdout directly. Satisfies "logs without exposing secrets". | Yes |
| D7 | Tests | **Vitest** + Fastify `inject` for HTTP + real Socket.IO clients for real-time | Single runner for unit/integration/websocket/concurrency; no separate transpile step. | Yes |
| D8 | **Authentication** | **Anonymous device-bound session JWT.** `POST /api/v1/auth/session { displayName, deviceId }` returns an HS256 JWT (`sub`=userId, 7-day TTL) signed with `AUTH_SECRET`. Sent as `Authorization: Bearer <jwt>` on REST and `auth.token` in the Socket.IO handshake. | The PDF requires owner/admin **authorization** but never asks for user accounts, passwords or profiles. A password flow would be invented scope; unauthenticated calls would make owner-only spin start unenforceable. Device-bound anonymous identity is the minimum mechanism that satisfies the requirement. No PII, no credentials stored. | Yes |
| D9 | Authorization model | Role on `room_members`: `OWNER` / `ADMIN` / `MEMBER`. Room creator is `OWNER`. **Only `OWNER`/`ADMIN` may start a spin.** Every room-scoped route requires `ACTIVE` membership. | Directly implements PDF "an admin or room owner starts the spin manually". | Yes |
| D10 | **Draft sharing contract** | **Metadata-only.** `POST /rooms/:id/drafts/share` carries `{ draftId, name, durationMs, effect, hostedFileUrl? }`. Audio bytes never leave the device. `hostedFileUrl` is accepted and persisted but the backend hosts no uploads. | Resolves Full Stack blocker **C1**. The PDF puts live audio streaming out of scope and describes Draft as "recording metadata and hosted file location" — a *location*, not a payload. Audio upload is nowhere required. Recorded as an assumption in the README. | Yes — adding object storage later does not change the event shape |
| D11 | **Participant leaves during an active spin** | **Immediate forfeit.** The member is assigned the next `elimination_order`, `final_status = 'LEFT'`, and `user_eliminated` is broadcast with `reason: "LEFT"`. If this leaves exactly 1 remaining, the winner is announced immediately. If it leaves 0, the spin is `ABORTED` with `abort_reason = 'NO_PARTICIPANTS'`. | Resolves blocker **C3**. "The last remaining participant is the winner" must stay literally true — a user who walked out cannot win, and a ghost winner would corrupt the persisted result. | Yes |
| D12 | **Owner/admin disconnects during an active spin** | **The spin continues unchanged. Ownership does not transfer.** Owner authority is required only to *start*. If the owner also leaves the room, D11 applies to them purely as a participant. | Resolves blocker **C3**. The PDF makes the server authoritative once running; halting on owner disconnect would invent a rule and hold every spin hostage to one mobile connection. | Yes |
| D13 | **Disconnect grace period** | **15 s** (`PRESENCE_GRACE_MS`). A socket drop sets `connection_status='DISCONNECTED'` but keeps membership. `user_left` fires only if the grace period expires without reconnect. An explicit `POST /leave` is immediate and skips the grace period. | Resolves blocker **C8**. Mobile networks drop routinely; instant removal would forfeit players (D11) for a two-second tunnel. | Yes |
| D14 | **Server restart during an active spin** | **Automatic resume, no special case.** `next_elimination_at` is persisted on the `spins` row. The scheduler claims due spins straight from the database (`FOR UPDATE SKIP LOCKED`), so a restarted process picks up `RUNNING` spins on its first tick. No in-memory timer is authoritative. | Resolves blocker **C3**. Makes restart recovery a property of the design rather than a recovery routine that can itself fail. | No |
| D15 | **Delayed / late timers** | The next deadline is computed from the **scheduled** time (`next_elimination_at + interval`), not from `now`, so drift never accumulates. **At most one elimination is processed per scheduler tick** — no catch-up bursts. If a spin is behind by more than `MAX_CATCHUP_LAG_MS` (default 15 s = 3 intervals), the deadline is **re-anchored** to `now + interval` so pacing returns to 5 s. | Resolves blocker **C3**. A downed server must not replay nine eliminations in one frame; users would see the wheel skip straight to a winner. | Yes |
| D16 | Elimination selection rule | **Uniform random** over remaining participants via `crypto.randomInt`. Every draw is persisted as a `spin_events` row *before* broadcast. | Resolves Full Stack gap #30. Fairness outranks reproducibility; auditability comes from persistence, not from a seed. | Yes |
| D17 | `eventId` and ordering | Every broadcast event carries `eventId` (UUID v4) and `occurredAt` (ISO-8601). Spin events additionally carry `seq` (BIGSERIAL from `spin_events`). **Clients must dedupe on `eventId`** and may order on `seq`. `room_state` always supersedes. | Resolves blockers **C4/C7**. The frontend plan omitted `eventId`; adopting it is assigned below. | Yes |
| D18 | Idempotency transport | Header **`Idempotency-Key`** (client-generated UUID). Stored per `(key, user_id, endpoint)` with the response status+body and a request-body hash. A replay returns the stored response; a *different* body under the same key returns `409 IDEMPOTENCY_KEY_REUSED`. TTL 24 h. **Required on Start Spin**, honoured on all POSTs. | Resolves blocker **C5**. The PDF scores "validation, error handling and idempotency" explicitly. | Yes |
| D19 | Reconnect sequencing | Client connects, server authenticates the handshake, **client emits `subscribe_room { roomId }`**, server validates membership, server emits `room_state`. Identical on first connect and on reconnect — one code path, not two. | Resolves blocker **C6**. A single path removes the "does the server push or does the client ask" ambiguity. | Yes |
| D20 | Socket.IO namespace / path | Namespace **`/rooms`**, default path `/socket.io`. Fan-out via Socket.IO room key `room:<roomId>`. | Matches the backend proposal; no competing option. | Yes |
| D21 | Error envelope | `{ "error": { "code", "message", "details"? }, "requestId" }` — stable machine-readable `code`, human-safe `message`, never a stack trace or driver text. | The frontend needs a status-to-UI mapping; the PDF requires safe error handling. | No (contract) |
| D22 | Rate limiting | `@fastify/rate-limit`: 120 req/min per IP+user globally; **6 req/min** on `POST /spin/start`. | Spin start is the abuse-prone, state-mutating operation. Deliberately not applied to `/health`. | Yes |
| D23 | CORS | Allowlist from `CORS_ALLOWED_ORIGINS`; **an empty allowlist in production denies all browser origins**. The Android client sends no `Origin`, so the APK is unaffected. | The PDF forbids an unjustified unrestricted production config. | Yes |
| D24 | Client stack | **Kotlin** + **Jetpack Compose** + **MVVM/StateFlow**, **Retrofit/OkHttp** (REST), **socket.io-client-java** (real-time), **Room** (local Draft store), **Oboe via JNI/C++** (audio). | Resolves the frontend plan's blocked technology rows. All are platform-default choices; none add product scope. | Yes |
| D25 | Implemented voice effect | **Echo (feedback delay)** in the native Oboe path, plus **Pitch Shift** — both implemented in C++ over the capture buffers. | The PDF requires "at least one". Echo is exactly expressible on a streaming ring buffer with no allocation on the audio thread. | Yes |
| D26 | Cloud provider | **Google Cloud Platform — Cloud Run + Cloud SQL (PostgreSQL) + Artifact Registry + Secret Manager** | Cloud Run terminates TLS and supports WebSocket upgrade with no extra load-balancer wiring, is Docker-native (the PDF requires Docker packaging) and bills to zero when idle. | No (infra-bound) |
| D27 | Instance topology | **Cloud Run `min-instances=1`, `max-instances=1`, session affinity on.** | Socket.IO fan-out across instances would need a Redis adapter — unnecessary scope here. The timer design (D14) is already multi-instance-safe, so raising `max-instances` later needs only the adapter, not a redesign. Stated as a known limitation. | Yes |
| D28 | CI/CD | **GitHub Actions**: install, typecheck, migrate and test against a Postgres service container, build image, push to Artifact Registry, deploy to Cloud Run, then **verify `/health` and `/ready` and roll back on failure**. Failing tests block deploy. | PDF: "installs dependencies, runs tests, builds and deploys" plus "document health verification and rollback approach". | Yes |
| D29 | Secrets | `AUTH_SECRET` and `DATABASE_URL` live in **GCP Secret Manager**, injected as env vars at deploy. Nothing secret in the repo; `.env.example` holds names only; `.gitignore` excludes `.env`. Startup **fails fast** if a required variable is missing or, in production, left at a development default. | The PDF requires environment-based configuration and documented secrets handling. | Yes |
| D30 | Migration tooling | Ordered `NNN_name.sql` files in `/database/migrations`, applied by an idempotent in-repo runner inside a transaction under an advisory lock, tracked in `schema_migrations`. | No extra dependency; the advisory lock makes concurrent deploys safe. | Yes |
| D31 | `SpinEvent` retention | Kept indefinitely for this assessment; documented as a known limitation with the cleanup query provided. | The audit trail is the evidence that the spin sequence was correct. Growth is negligible at assessment scale. | Yes |
| D32 | Health vs readiness | `GET /health` is process liveness only, with no DB call. `GET /ready` runs `SELECT 1` against Postgres plus a migration-state check and returns 503 when not ready. | A liveness probe that depends on the DB causes restart storms during a database blip. | Yes |

---

## Requirements confirmed unchanged

These come from the PDF and are **not** decisions — they are constraints no agent may alter:

```
3-20 eligible users              one active spin per room
owner/admin starts manually      one elimination every 5 seconds
last remaining participant wins  result persisted
7 mandatory WebSocket events     backend is authoritative
no live audio over WebSocket     Docker packaging required
cloud deployment required        no payment/wallet/real money
out of scope: WebRTC, LiveKit, AI, Kubernetes, multi-tenant
```

---

## Assignments issued

| Owner | Assignment |
|---|---|
| Backend | Implement D1–D23, D30–D32. Freeze `/docs/api/openapi.yaml` and `/docs/api/websocket-events.md` as the single contract. |
| Frontend | Implement D24, D25. **Adopt `eventId` dedupe (D17) and `Idempotency-Key` (D18)** — both were missing from the frontend plan. Render D11/D12/D13 outcomes from server events only. |
| Full Stack | Re-run the audit against real code; produce `FRONTEND_AUDIT.md`, `BACKEND_AUDIT.md` and `INTEGRATION_CONTRACT.md` as files. |
| DevOps | Implement D26–D29. Do not declare deployment successful without external verification. |

---

## TECH MANAGER DECISION

```
STATUS: APPROVED FOR IMPLEMENTATION

REQUIRED CHANGES CLOSED: all 16 items in TECH_MANAGER_REQUIREMENTS.md section 16
                         all 12 backend blockers
                         all 10 escalations in INTEGRATION_CONTRACT.md section 6
                         all 16 DevOps blockers

APPROVED TECHNOLOGY:
  Node.js 22 - TypeScript - Fastify 5 - Socket.IO 4 - PostgreSQL 16
  Zod - Pino - Vitest - Docker - GitHub Actions
  GCP Cloud Run + Cloud SQL + Artifact Registry + Secret Manager
  Kotlin - Jetpack Compose - Retrofit - socket.io-client-java - Room - Oboe (C++/JNI)

APPROVED ARCHITECTURE:
  Android (local Oboe audio) --REST--+
                             --WSS---+
                                     v
                     Node.js authoritative backend
                                     v
                                PostgreSQL

  Spin timing is database-driven, never in-memory-authoritative.
  Events are persisted before they are broadcast.

CONSTRAINT ON IMPLEMENTERS:
  No agent may alter D8, D10, D11, D12, D14 or D15 without returning to this gate --
  these are the decisions that changed behaviour the PDF left undefined.
```
