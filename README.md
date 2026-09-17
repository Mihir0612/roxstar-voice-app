# Roxstar — Voice Draft, Real-Time Room and Spin Wheel

Android voice recording through Oboe, a Node.js real-time room service, and a
multiplayer spin wheel.

| | |
|---|---|
| **Backend** | Node.js 22 · TypeScript · Fastify 5 · Socket.IO 4 · PostgreSQL 16 |
| **Android** | Kotlin · Jetpack Compose · Oboe (C++/JNI) · Retrofit · Room |
| **Infrastructure** | Docker · GitHub Actions · GCP Cloud Run + Cloud SQL |
| **Tests executed** | **209 passing** — 90 backend, 45 native DSP, 57 end-to-end, 17 Android |

---

## Status, stated plainly

| Deliverable | State |
|---|---|
| Backend, database, tests | **Complete and verified** — 90 tests against a real Postgres |
| Docker packaging | **Complete and verified** — image built, run, exercised |
| End-to-end verification | **Complete** — 57/57 against the running container |
| Android app + native Oboe | **Built** — debug and release APKs, native libs for arm64-v8a and x86_64 |
| CI/CD pipeline | **Written**, not executed (needs a GitHub repo + secrets) |
| Cloud deployment assets | **Written**, not applied (needs GCP credentials) |
| **Cloud deployment** | **NOT DONE** — no credentials in this environment |
| **Release APK** | **BUILT** — 4.8 MB R8-minified, pending a signing key |
| **Demo recording** | **NOT PRODUCED** — needs a device and a person |

The remaining "not done" items are blocked by things this machine does not have,
not by the code. `DEPLOYMENT_VERIFICATION.md` records exactly what was executed
and what was not — nothing is claimed that was not run.

---

## Quick start

> **Want to run it on a phone?** See **[RUNNING.md](./RUNNING.md)** — it covers
> installing the APK, reaching the backend over your LAN, and the bot helper
> that lets one device test a spin that needs three players.

```bash
# 1. Backend + database
docker compose up -d

# 2. Confirm it is actually working (not just running)
cd tests && npm ci && node e2e/verify.mjs http://localhost:8080
```

Expected:

```
====================================================
  57 passed, 0 failed

  VERDICT: VERIFIED against http://localhost:8080
====================================================
```

### Development mode

```bash
docker compose up -d postgres

cd backend
npm ci
cp .env.example .env
npm run migrate
npm run dev
```

### Tests

```bash
cd backend && npm test                      # 90 backend tests
cd native-audio/tests && ./run.sh --docker  # 45 native DSP tests, no NDK needed
cd tests && node e2e/verify.mjs             # 57 end-to-end checks
cd android-app && ./gradlew test            # 17 JVM unit tests (needs JDK 17)
```

### Android

Needs Android Studio with the **NDK** and CMake installed — the audio engine is
C++. See [`android-app/README.md`](./android-app/README.md).

Install **NDK** and **CMake** from Android Studio → Settings → Languages &
Frameworks → Android SDK → SDK Tools. Then:

```bash
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"
cd android-app
./gradlew assembleDebug        # points at http://10.0.2.2:8080 (emulator → host)
./gradlew assembleRelease -PROXSTAR_API_BASE_URL=https://your-service.run.app
```

A **release** build refuses to compile against a localhost or placeholder URL —
verified: both are rejected with a message naming the problem.

Built and verified on NDK 30.0.16248370, CMake 3.22.1 (AGP installs this itself)
and Temurin JDK 17. `ndkVersion` is pinned in `app/build.gradle.kts`; override it
with `-PROXSTAR_NDK_VERSION=...` if your SDK has a different one.

---

## What it does

```
Record a voice clip through Oboe
   → apply Echo or Pitch Shift in the native path
   → save as a local Draft
   → create or join a room
   → share the Draft's metadata with the room
   → owner starts the spin with 3–20 players
   → one player eliminated every 5 seconds
   → one winner, persisted and broadcast
```

### Two boundaries that shape everything

**1. Audio is local.** The WAV never crosses the network. Sharing a draft sends
name, duration and effect — nothing else. Live audio streaming is out of scope,
and the e2e suite asserts that no event payload contains audio data.

**2. The backend is authoritative.** The client renders spin state; it never
computes it. No local elimination timer, no local winner. The server owns the
clock, and that clock lives in the database rather than in a `setInterval`.

---

## Repository

```
/android-app        Kotlin + Compose client
/native-audio       Oboe C++ notes and host-runnable DSP tests
/backend            Node.js + TypeScript service
/database           PostgreSQL schema and migrations
/infrastructure     Terraform + gcloud scripts for GCP
/docs/architecture  System, audio, event-flow, spin and ER diagrams
/docs/api           OpenAPI spec + WebSocket event contract
/tests              Out-of-process end-to-end verification
Dockerfile          Multi-stage backend image (built from the repo root)
```

### Documents

| Document | What it is |
|---|---|
| [`TECH_MANAGER_REQUIREMENTS.md`](./TECH_MANAGER_REQUIREMENTS.md) | Requirements extracted from the PDF |
| [`TECH_MANAGER_DECISIONS.md`](./TECH_MANAGER_DECISIONS.md) | **32 decisions (D1–D32) closing every open question.** Start here to understand *why* anything is the way it is. |
| [`docs/api/openapi.yaml`](./docs/api/openapi.yaml) | The frozen REST contract |
| [`docs/api/websocket-events.md`](./docs/api/websocket-events.md) | The frozen event contract |
| [`docs/architecture/README.md`](./docs/architecture/README.md) | Five diagrams |
| [`BACKEND_AUDIT.md`](./BACKEND_AUDIT.md) · [`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md) · [`INTEGRATION_CONTRACT.md`](./INTEGRATION_CONTRACT.md) | Integration audits against the real code |
| [`DEVOPS_DEPLOYMENT_PLAN.md`](./DEVOPS_DEPLOYMENT_PLAN.md) · [`DEPLOYMENT_VERIFICATION.md`](./DEPLOYMENT_VERIFICATION.md) | Deployment and what was actually verified |
| [`RUNNING.md`](./RUNNING.md) | Getting the app onto a device and testing every flow by hand |

---

## Design decisions worth reading

Full reasoning in `TECH_MANAGER_DECISIONS.md`. The five that shape behaviour the
PDF left undefined:

### Authentication (D8) — anonymous, device-bound sessions

The PDF requires owner/admin **authorization** but never asks for accounts. A
password flow would be invented scope; unauthenticated calls would make
owner-only spin start unenforceable. So: a display name plus a device id
exchanges for a 7-day HS256 bearer token. No passwords, no PII.

### Draft sharing (D10) — metadata only

The PDF puts live audio streaming out of scope and describes a Draft as
"recording metadata and hosted file location" — a *location*, not a payload.
Audio upload is nowhere required, so nothing is uploaded. Adding object storage
later would not change the event shape.

### Leaving during a spin (D11) — immediate forfeit

"The last remaining participant is the winner" has to stay literally true. A
user who walked out cannot win, and a ghost winner would be persisted as the
result. So a departure is recorded as `LEFT` with the next elimination order and
broadcast with `reason: "LEFT"`, so the UI can say "forfeited" rather than
"eliminated".

### Owner disconnects (D12) — the spin continues

Owner authority is required to *start*, not to continue. Halting on an owner
disconnect would invent a rule and hold every spin hostage to one phone.

### The timer (D14, D15) — the database is the clock

`spins.next_elimination_at` is persisted. The scheduler polls the database for
due spins and claims them with `FOR UPDATE SKIP LOCKED`. Consequences:

- **A restart is a non-event.** A fresh process finds `RUNNING` spins on its
  first ordinary tick. There is no recovery routine, so there is no recovery
  routine to get wrong. *Observed live:* a rebuilt container picked up an
  in-flight spin and completed it.
- **No drift.** Each deadline is computed from the *scheduled* time, not from
  `now`. 100 consecutive late ticks accumulate zero drift.
- **No catch-up burst.** If the process was down longer than 15 seconds, the
  deadline re-anchors instead of replaying nine eliminations in one frame.

---

## Edge cases — implemented and tested

The PDF asks for at least three. All ten of its suggestions are implemented, and
each has a test that asserts the behaviour.

| # | Case | Behaviour | Test |
|---|---|---|---|
| 1 | Duplicate start request | Same `Idempotency-Key` replays the original spin | `edge-cases.test.ts` |
| 2 | Simultaneous starts | 5 concurrent → exactly one 201, four 409 | ” |
| 3 | Simultaneous joins | 5 concurrent joins → one membership | ” |
| 4 | User leaves mid-spin | Forfeit as `LEFT`; cannot win | ” |
| 5 | Admin disconnects mid-spin | Spin continues; no ownership transfer | ” |
| 6 | Insufficient players | 409 with the actual counts | `spin.test.ts` |
| 7 | Last players leave | `ABORTED` / `NO_PARTICIPANTS`; never left dangling | `edge-cases.test.ts` |
| 8 | Duplicate events | 10 concurrent ticks × 6 rounds → exactly N−1 eliminations | ” |
| 9 | Delayed timers / restart | Resumes from the persisted deadline; re-anchors, no burst | ” |
| 10 | Reconnect during a spin | `room_state` carries everything missed | ” + `events.test.ts` |

Plus: too many players, unauthorised start, non-member access, malformed
payloads, draft hijack attempts, rate limiting, and a retried leave.

---

## Testing

| Suite | Count | What it proves |
|---|---|---|
| `backend/tests/unit` | 14 | Timer maths; config fail-fast rules |
| `backend/tests/integration` | 46 | REST, auth, validation, spin lifecycle, rate limits, real 5 s pacing |
| `backend/tests/websocket` | 12 | All 7 events over **real** sockets |
| `backend/tests/concurrency` | 18 | All 10 edge cases |
| `native-audio/tests` | 45 | Echo, pitch shift, WAV — **measured, not asserted** |
| `tests/e2e` | 57 | The real journey, out of process |
| `android-app` unit tests | 17 | Spin gating, JNI contract |

**Tests run against a real PostgreSQL**, never a mock. The spin rules depend on
partial unique indexes, row locks and `SKIP LOCKED`; a fake reproduces none of
them, so a green mock suite would prove nothing.

They use a **separate database** (`roxstar_test`) from the one `docker compose`
serves. Sharing one makes the suite non-deterministic: the compose backend runs
a scheduler that polls for due spins across its whole database every 500 ms, and
it will happily claim and complete a test's spin before the test observes it.
Created automatically by CI; locally, once:

```bash
docker exec roxstar-postgres psql -U roxstar -d postgres -c "CREATE DATABASE roxstar_test OWNER roxstar;"
```

### Two bugs the tests actually caught

Worth naming, because they are the argument for testing this way at all.

**1. The pitch shifter was broken.** It advanced its read pointer by
`pitchRatio` instead of ramping the read *delay* by `1 − pitchRatio`. A no-op
shift produced 7.8 Hz of noise; a +12-semitone shift produced no change. The
code read plausibly and would have passed review. Feeding in a 440 Hz tone and
**measuring the output frequency** is what caught it.

**2. `POST /leave` returned 400 from any real HTTP client.** Fastify's default
JSON parser rejects an empty body when the client still sends
`Content-Type: application/json` — which Retrofit and `fetch` both do. The
in-process suite passed, because `app.inject()` omits the header. On a device
this ships as "the Leave button does nothing." Found by the out-of-process e2e
suite; fixed, with regression cover added.

---

## Security

| Control | Implementation |
|---|---|
| Input validation | Zod at every boundary, every string bounded |
| Authentication | HS256, algorithm pinned, issuer checked |
| Authorization | Role on `room_members`; owner/admin for spin start |
| Injection | Parameterised SQL throughout; no ORM hiding it |
| Rate limiting | 120/min global; 6/min on spin start |
| Secrets | Env only; startup refuses the dev default in production |
| Error safety | Generic `INTERNAL_ERROR`; no stack trace or SQL ever reaches a client |
| Logging | Pino redacts authorization, tokens, `DATABASE_URL` |
| CORS | Allowlist; **empty in production denies all browser origins** |
| Container | Non-root, multi-stage, no dev dependencies |
| Client | Token in memory only; HTTP logging disabled in release |

Auth failures are deliberately indistinguishable: a forged, wrongly-signed and
expired token all return the identical 401, so token probing yields no signal.
There is a test for that.

---

## Assumptions

1. **Draft sharing is metadata-only.** The PDF never asks for audio upload and
   puts streaming out of scope.
2. **Anonymous sessions are sufficient authentication.** No account system is
   requested; authorization is what the PDF actually requires.
3. **The spin roster freezes at start.** Otherwise "3–20 eligible users" is
   unverifiable at any single moment.
4. **A disconnect is not a departure** for 15 seconds.
5. **Virtual points are not implemented.** The PDF says they "may" be awarded;
   wallets and payments are explicitly out of scope, so the winner is recorded
   and nothing is credited.

---

## Known limitations

**Single instance.** Socket.IO fan-out is in-process, so Cloud Run is pinned to
`max-instances=1`. The spin timer is *already* multi-instance-safe — it claims
work from the database — so scaling out needs a Redis adapter and nothing else.
Not a redesign; just scope this assessment does not call for.

**Rate limiting is per-instance.** Correct at one instance; needs a shared store
if that changes.

**No `spin_events` retention.** Negligible here; the cleanup query is in
`database/README.md`.

**"Reverb" is echo-based.** It is a short, dense, high-feedback delay — not a
Schroeder or FDN reverb. It is labelled *"Reverb (echo-based)"* in the UI, and a
test asserts the label says so. Echo and Pitch Shift are the two effects
genuinely implemented; the PDF requires one.

**Tokens cannot be revoked** before their 7-day expiry. Fine for anonymous
throwaway sessions; would not be for real accounts.

**No load testing.** A 20-participant spin is exercised functionally, not for
throughput.

---

## Deploying

```bash
# 1. Provision
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in; gitignored
terraform init && terraform apply

# or without Terraform
export GCP_PROJECT_ID=your-project
./infrastructure/gcp/deploy.sh

# 2. VERIFY. Uploading is not deploying.
cd tests && node e2e/verify.mjs https://roxstar-backend-xxxxx.a.run.app

# 3. Only after that prints VERIFIED, point the APK at it
#    android-app/gradle.properties → ROXSTAR_API_BASE_URL=https://...
cd android-app && ./gradlew assembleRelease
```

Rollback: `./infrastructure/gcp/rollback.sh`, or automatically in CI when
post-deploy verification fails.

---

## Demo checklist

For the 5–10 minute recording the PDF asks for:

1. Record a clip with Echo → Oboe path, live level meter
2. Apply Pitch Shift → the effect is audible
3. Save, list, play, delete a Draft
4. Create a room; join from a second client with the code
5. `user_joined` / `user_left` / `draft_shared` arriving live
6. Start a spin with 3 players
7. Eliminations every 5 s → exactly one winner
8. Kill a client mid-spin, reconnect → `room_state` recovers everything
9. Three edge cases: duplicate start (409), leave mid-spin (forfeit), restart the container mid-spin (resumes)
10. `npm test`, `verify.mjs`, the hosted endpoint, the CI run
11. One expected failure: start a spin with 2 players → 409 with the counts
