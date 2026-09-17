# DEPLOYMENT_VERIFICATION.md

**Verified by:** Senior DevOps Engineer
**Target:** containerised deployment, `http://localhost:8080` (docker-compose)
**Date of run:** 2026-09-17
**Result:** **VERIFIED LOCALLY. CLOUD DEPLOYMENT NOT PERFORMED.**

---

## Scope, stated plainly

The PDF does not accept a local-only backend as the final submission, and this
document does not claim one.

What follows is a record of what was **actually executed and observed**. The
cloud deployment has not happened, because this environment has no GCP
credentials and deploying to a real cloud account is the user's decision to
make. Every asset needed for it exists and is listed in
`DEVOPS_DEPLOYMENT_PLAN.md` §9.

The same verification script runs unchanged against a Cloud Run URL:

```bash
node tests/e2e/verify.mjs https://roxstar-backend-xxxxx.a.run.app
```

---

## 1. Deployment audit

| Item | Required | State | Evidence |
|---|---|---|---|
| Backend build | yes | PASS | `tsc` clean, `npm run build` succeeds |
| Package manifest + lockfile | yes | PASS | `backend/package.json`, `package-lock.json` |
| Production start command | yes | PASS | `node dist/server.js` |
| Environment contract | yes | PASS | `backend/.env.example`, validated at startup |
| Health endpoint | yes | PASS | `GET /health` → 200 |
| Readiness endpoint | yes | PASS | `GET /ready` → 200 |
| Database connection | yes | PASS | `"database":"ok"` |
| Migrations | yes | PASS | 2 applied at boot |
| Dockerfile | yes | PASS | multi-stage, non-root, healthcheck |
| `.dockerignore` | yes | PASS | excludes `node_modules`, `.env`, tests |
| Image size | — | 270 MB | alpine, runtime deps only |
| Port configuration | yes | PASS | `PORT` env, Cloud Run compatible |
| WebSocket support | yes | PASS | real clients connected |
| CORS | yes | PASS | allowlist; empty in production denies all |
| Secrets | yes | PASS | env only; nothing in the image or the repo |
| Logging | yes | PASS | Pino JSON to stdout with redaction |

---

## 2. Container

```
$ docker build -t roxstar-backend:local .
  ... exporting to image ... DONE

$ docker compose up -d
  Container roxstar-postgres  Healthy
  Container roxstar-backend   Started

$ docker compose ps
NAME               STATUS
roxstar-backend    Up 32 minutes (healthy)
roxstar-postgres   Up 50 minutes (healthy)
```

Startup log, migrations applied and workers running:

```json
{"level":"info","msg":"Applied migration","migration":"001_initial_schema.sql"}
{"level":"info","msg":"Applied migration","migration":"002_updated_at_triggers.sql"}
{"level":"info","msg":"Background workers started","spinTickMs":500,"presenceTickMs":1000,"graceMs":15000}
{"level":"info","msg":"Roxstar backend listening","port":8080,"env":"production","workers":true}
```

---

## 3. Health and readiness

```
$ curl -s http://localhost:8080/health
{"status":"ok","service":"roxstar-backend","uptimeSeconds":1924,"timestamp":"2026-09-17T17:07:36.051Z"}

$ curl -s http://localhost:8080/ready
{"status":"ready","database":"ok","pendingMigrations":0}
```

---

## 4. Functional verification — 57/57

`node tests/e2e/verify.mjs http://localhost:8080`, driving the container from
**outside the process** over real HTTP and real WebSockets.

| Section | Checks | Result |
|---|---|---|
| 1. Health and readiness | 5 | PASS |
| 2. Authentication and authorization | 4 | PASS |
| 3. Room lifecycle | 4 | PASS |
| 4. Authorization rules | 3 | PASS |
| 5. WebSocket connection and events | 2 | PASS |
| 6. Draft sharing | 4 | PASS |
| 7. Spin lifecycle | 13 | PASS |
| 8. Persistence | 6 | PASS |
| 9. Reconnect and state recovery | 3 | PASS |
| 10. Expected failure handling | 7 | PASS |
| 11. Departure handling | 4 | PASS |
| **Total** | **57** | **57 PASS, 0 FAIL** |

```
====================================================
  57 passed, 0 failed

  VERDICT: VERIFIED against http://localhost:8080
====================================================
```

### Observations worth recording

**Spin pacing.** 3 players, 2 eliminations, winner announced after **10 405 ms**
against an expected 10 000 ms. A 4 ms average deviation per interval, through a
500 ms database-polled scheduler.

**Idempotency.** A retried start with the same `Idempotency-Key` returned the
same `spinId`, and a direct SQL count confirmed one spin row. A *fresh*
duplicate start returned `409 SPIN_ALREADY_RUNNING`.

**Restart recovery, observed by accident and worth more than the test.** When the
container was rebuilt, a `RUNNING` spin left in the database from the previous
run was picked up by the new process on its first scheduler tick and driven to
completion:

```json
{"level":"info","msg":"Spin completed","roomId":"e6a01810-...","spinId":"38051ffa-...","winnerUserId":"bfa4e90d-..."}
```

No recovery routine ran. The spin resumed because the deadline lives on the row
and the scheduler polls the database — which is the whole point of D14.

**No audio on the wire.** Every event payload was scanned for `base64`,
`audioData`, `pcm` and `data:audio`. None found, on any event.

**Error safety.** Every error body was checked for `postgres`, `relation`,
`.ts:NN` and stack frames. None leaked.

---

## 5. A real defect this caught

The e2e run **failed on its first execution**, at section 11:

```
11. Departure handling
  FAIL  member can leave
  FAIL  repeated leave is idempotent
```

`POST /leave` returned 400. Cause: Fastify's default JSON parser rejects an empty
body when the client still sends `Content-Type: application/json` — which every
real HTTP client does on a POST with no payload. The in-process suite
passed because `app.inject()` omits the header.

On a device this would have shipped as *"the Leave button does nothing."*

Fixed in `backend/src/app.ts`, two regression tests added, container rebuilt,
re-run: 57/57.

**This is the argument for out-of-process verification in one example.** Unit and
integration tests are necessary and they were not sufficient.

---

## 6. Test evidence

| Suite | Count | Result |
|---|---|---|
| Backend (unit, integration, websocket, concurrency) | 90 | 90 PASS |
| Native DSP (host-compiled C++) | 45 | 45 PASS |
| End-to-end against the container | 57 | 57 PASS |
| Android JVM unit tests | 17 | written; not executed — no JDK 17 here |
| **Executed total** | **192** | **192 PASS** |

---

## 7. Production verification — status per item

| Item | How it will be verified | State |
|---|---|---|
| Backend reachable externally | `curl` from another network | **NOT DONE** — not deployed |
| Database reachable | `/ready` against the live URL | **NOT DONE** |
| REST APIs working | `verify.mjs <cloud-url>` | **NOT DONE** |
| WebSocket working | same script, real socket | **NOT DONE** |
| Authentication working | same script | **NOT DONE** |
| CORS working | preflight against the live URL | **NOT DONE** |
| Environment variables working | `/ready` + startup log | **NOT DONE** |
| APK connects to the deployed backend | install and run the release APK | **NOT DONE** — no NDK |
| Logs available | Cloud Logging | **NOT DONE** |
| Failure handling | same script, section 10 | verified locally |
| Rollback | `rollback.sh` | written, not exercised |

Everything in that list runs from the one command in
`DEVOPS_DEPLOYMENT_PLAN.md` §9 once credentials exist.

---

## 8. Verdict

```
LOCAL CONTAINERISED DEPLOYMENT:  VERIFIED (57/57 functional checks)
CLOUD DEPLOYMENT:                NOT PERFORMED
APK:                             NOT BUILT (no NDK in this environment)
DEMO RECORDING:                  NOT PRODUCED
```

The backend is production-shaped and proven to work as a container. It has not
been put on the internet, and this document does not pretend otherwise.

> The rule from the brief: *do not say "deployment successful" merely because
> the server uploaded.* Nothing has been uploaded, so nothing is claimed.
