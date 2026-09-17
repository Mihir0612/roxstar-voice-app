# BACKEND_AUDIT.md

**Auditor:** Senior Full Stack Integration Developer
**Target:** the implemented backend in `/backend`, not the plan
**Basis:** `TECH_MANAGER_REQUIREMENTS.md`, `TECH_MANAGER_DECISIONS.md`, the assessment PDF
**Verdict:** **PASS — cleared for integration**

> This supersedes the plan-stage audit embedded in `FULLSTACK_IMPLEMENTATION_PLAN.txt`,
> which could only assess intent. Every row below was checked against code that
> runs, and against a test suite that was executed.

---

## 1. Requirements coverage

| Requirement | Where | Verified by | Verdict |
|---|---|---|---|
| Node.js authoritative backend | `src/services/*` | 90 tests | PASS |
| REST: room / draft / spin / health | `src/routes/index.ts` | `tests/integration/rooms.test.ts` | PASS |
| WebSocket: 7 mandatory events | `src/websocket/` | `tests/websocket/events.test.ts` (12 tests, real sockets) | PASS |
| 3–20 eligible users | `spin.service.ts:startSpin` | 4 boundary tests (2, 3, 20, 21) | PASS |
| Owner/admin starts manually | `startSpin` role check | non-admin and non-member both 403 | PASS |
| Only one active spin | partial unique index + row lock | 5 concurrent starts → exactly one 201 | PASS |
| One elimination per 5 s | `processSpinTick` + persisted deadline | `spin-timing-real.test.ts`, wall-clock 10.4 s for 3 players | PASS |
| Last participant wins | `finishWithWinner` | exactly one `WINNER` asserted | PASS |
| Result persisted | `spins.winner_user_id`, `completed_at` | read back via SQL, not just the API | PASS |
| Complete event sequence broadcast | `spin_events` + broadcaster | order asserted end to end | PASS |
| Reconnect / state sync | `subscribe_room` → `room_state` | reconnect-mid-spin test | PASS |
| Entities: User, Room, RoomMember, Draft, Spin, SpinParticipant, SpinEvent | `001_initial_schema.sql` | all 7 present | PASS |
| Validation, error handling, idempotency | Zod, `AppError`, `Idempotency-Key` | 21 integration tests | PASS |
| Logging | Pino with redaction | redact list reviewed | PASS |
| Docker | root `Dockerfile` | image built and run | PASS |
| No live audio over WebSocket | — | e2e asserts no audio in any payload | PASS |

---

## 2. Architecture boundaries

```
REST      → routes → services → repositories → Postgres
Socket.IO → handlers → services → repositories → Postgres
scheduler → services → repositories → Postgres
```

Checked and confirmed:

- **Routes contain no business logic.** Every one parses, authorises, delegates,
  shapes. The spin rules live in `spin.service.ts` only, so the WebSocket layer
  and the tests exercise the same code rather than a copy.
- **Repositories are the only SQL.** No query escapes into a service.
- **Every statement is parameterised.** Grepped for template-literal
  interpolation in SQL: none.
- **WebSocket handlers trust nothing from the client.** `subscribe_room`
  re-checks membership server-side; the client can emit only subscribe and
  unsubscribe.
- **Persist before broadcast.** Services collect pending broadcasts inside the
  transaction and flush them after commit (`spin.service.ts:flush`). A crash can
  lose a broadcast; it cannot produce one the database does not record.

**One deliberate deviation from the plan.** The plan had the scheduler claiming a
whole batch under one transaction. The implementation reads candidate ids
unlocked and claims each spin individually with `FOR UPDATE SKIP LOCKED`, so one
slow spin cannot hold a transaction open across the batch, and a failure in one
spin cannot roll back another's elimination. Strictly better; noted rather than
flagged.

---

## 3. API contract

Frozen in `docs/api/openapi.yaml`, which parses as valid OpenAPI 3.0.3 (13 paths,
10 schemas). Every path was exercised.

| Checked | Result |
|---|---|
| Paths match the spec | PASS |
| Status codes match | PASS — 201 create, 200 join/leave/state, 204 delete, 4xx per `code` |
| Error envelope is uniform | PASS — `{ error: { code, message, details? }, requestId }` on every failure |
| `code` values match the enum | PASS |
| Idempotency honoured | PASS — replay returns the stored response; a changed body under the same key returns 409 |
| Auth enforced per route | PASS — `/health`, `/ready`, `/auth/session` public; everything else `requireAuth` |

### Defect found and fixed during this audit

`POST /leave` and `POST /spin/start` take no body. Fastify's default JSON parser
**rejects an empty body outright** when the client still sends
`Content-Type: application/json` — which every real HTTP client does. The
in-process test suite passed because `app.inject()` omits the header.

Caught by `tests/e2e/verify.mjs`, which drives the server over real HTTP.
Fixed by a content-type parser that treats an empty body as `{}` while still
returning a clean 400 for malformed JSON. Two regression tests added so the
in-process suite can catch this class of bug in future.

**This is exactly the failure mode the integration audit exists for**, and it
would have shipped as "the Leave button does nothing" on a real device.

---

## 4. Real-time layer

| Checked | Result |
|---|---|
| Namespace `/rooms` | PASS |
| Handshake auth | PASS — no token and forged token both `connect_error: UNAUTHENTICATED` |
| Auth failures are opaque | PASS — cannot distinguish absent / forged / expired |
| Membership re-checked on subscribe | PASS — a non-member's subscribe is refused |
| `eventId` on every event | PASS — UUID v4, uniqueness asserted |
| `seq` on spin events | PASS — monotonic, from `spin_events.seq` |
| Room isolation | PASS — a spin in room A produces nothing in room B |
| Reconnect recovery | PASS — one code path; `room_state` carries everything missed |
| Malformed payload handling | PASS — rejected via ack, the socket survives |

**Gap accepted:** Socket.IO fan-out is in-process, so it works only on a single
instance. Cloud Run is pinned to `max-instances=1` (D27) and the timer design is
already multi-instance-safe, so scaling out needs a Redis adapter and nothing
else. Documented as a known limitation rather than hidden.

---

## 5. Spin engine

| Property | Mechanism | Verified |
|---|---|---|
| One active spin | partial unique index + `SELECT … FOR UPDATE` on the room | 5 concurrent starts → 1 created, 4 × 409 |
| No double elimination | `FOR UPDATE SKIP LOCKED` per spin | 10 concurrent ticks × 6 rounds → exactly N−1 eliminations |
| Fair selection | `crypto.randomInt` | reviewed; not `Math.random` |
| Auditable sequence | `spin_events` written in-transaction, pre-broadcast | event types and order asserted from SQL |
| Restart recovery | deadline on the row; scheduler polls the DB | deadline forced into the past → next tick resumes |
| No catch-up burst | re-anchor beyond `MAX_CATCHUP_LAG_MS` | 5-minute-stale deadline → exactly 1 elimination, not 4 |
| No drift | next deadline from the *scheduled* time | 100 late ticks → 0 ms accumulated drift |

The three rules the plan left open are now decided, implemented and tested:

- **Participant leaves mid-spin** → forfeit as `LEFT`, next elimination order,
  `user_eliminated` with `reason: "LEFT"`. Asserted that a departed user cannot
  win.
- **Owner disconnects mid-spin** → the spin continues; ownership does not
  transfer. Asserted the spin stays `RUNNING` and the owner stays `ACTIVE`.
- **Everyone leaves** → `ABORTED` / `NO_PARTICIPANTS`. Asserted no spin is ever
  left dangling in `RUNNING` with an empty room.

**Observation, not a defect:** the roster is frozen at start. A user joining
mid-spin is a spectator. This is the only reading under which "3–20 eligible
users" is verifiable at a single moment, it is documented in the OpenAPI spec,
and it is asserted by a test.

---

## 6. Database

| Checked | Result |
|---|---|
| 7 required entities | PASS |
| Constraints carry the rules | PASS — see the table in `docs/architecture/README.md` |
| Indexes serve real queries | PASS — each one maps to a specific hot path |
| Transactions on critical paths | PASS — join, leave, share, start, tick, forfeit |
| Migrations ordered and tracked | PASS — advisory lock, one transaction per file |
| No ORM hiding lock semantics | PASS — raw parameterised SQL |

**Accepted limitations:**

- `spin_events` has no retention policy. Negligible at assessment scale; the
  cleanup query is documented in `database/README.md`.
- `fallbackToDestructiveMigration` on the **Android** Room database. That table
  is a cache over local files and can be re-derived; the server schema uses real
  migrations. Called out here so the difference is deliberate, not an oversight.

---

## 7. Security

| Area | Implementation | Verified |
|---|---|---|
| Input validation | Zod at every boundary, all strings bounded | malformed payloads → 400 |
| Authentication | HS256, algorithm pinned, issuer checked | forged / wrong-secret / expired all identical 401 |
| Authorization | role on `room_members`; owner/admin for start | non-admin 403, non-member 403 |
| Ownership | draft upsert guarded by `owner_id` | a hijack attempt returns 404, not 403 |
| Injection | parameterised SQL throughout | reviewed |
| Rate limiting | 120/min global, 6/min on spin start | asserted at production values |
| Secrets | env only, fail-fast, `.gitignore` covers `.env`/tfstate/tfvars | config tests |
| Error safety | generic `INTERNAL_ERROR`, never a stack trace | asserted no `postgres`/`relation`/`.ts:` in a body |
| Logging | Pino redacts authorization, tokens, `DATABASE_URL` | redact list reviewed |
| CORS | allowlist; empty in production denies all origins | config test |
| Payload size | 256 KB body limit, 64 KB socket buffer | reviewed |
| Container | non-root, multi-stage, no dev deps | Dockerfile reviewed |

**Residual risks, accepted and stated:**

1. A token stays valid for 7 days with no revocation list. Appropriate for
   anonymous throwaway sessions; would not be for real accounts.
2. Rate limiting is per-instance and in-memory. Correct at one instance; needs a
   shared store if `max-instances` is ever raised.
3. `deviceId` is client-supplied, so a determined client can mint identities.
   It gates nothing valuable — room membership is still explicit — but it is not
   an anti-abuse control and is not presented as one.

---

## 8. Tests

**90 tests across 8 files, all passing** (three consecutive clean runs), against a real PostgreSQL — no mocked
database, because the spin rules depend on partial unique indexes, row locks and
`SKIP LOCKED`, and a fake would reproduce none of them.

| Suite | Tests | Covers |
|---|---|---|
| `unit/spin-timing` | 5 | drift, catch-up, re-anchor, boundary |
| `unit/config` | 9 | fail-fast rules, PDF defaults |
| `integration/rooms` | 23 | REST, auth, validation, error safety |
| `integration/spin` | 22 | eligibility, elimination, winner, persistence |
| `integration/rate-limit` | 2 | throttling at production values |
| `integration/spin-timing-real` | 1 | real 5 s cadence, real scheduler, ~10.4 s |
| `websocket/events` | 12 | all 7 events over real sockets |
| `concurrency/edge-cases` | 18 | all 10 named edge cases |

Plus **57 out-of-process e2e checks** against the running container, and **45
native DSP tests** compiled and run on the host.

**Gap:** no coverage threshold is configured, and no load test at 20
participants. The 20-participant path is exercised functionally but not for
throughput.

---

## 9. Verdict

**PASS — cleared for integration.**

The backend implements every scored requirement, enforces its invariants in the
database rather than only in code, and its edge-case behaviour is tested rather
than described. One real defect was found and fixed during the audit; two
limitations (single-instance fan-out, no event retention) are accepted and
documented rather than concealed.
