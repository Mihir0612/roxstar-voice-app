# DEVOPS_DEPLOYMENT_PLAN.md

**Role:** Senior DevOps Engineer
**Status:** Assets complete and locally verified. **Cloud deploy not executed** — see §8.
**Supersedes:** the plan-stage version in `DEVOPS_IMPLEMENTATION_PLAN.txt`, which was blocked on decisions that are now made.

---

## 1. What changed since the plan

Every blocker that document listed is closed:

| Blocker | Resolution |
|---|---|
| No integrated artifact | Backend built, containerised, 90 tests + 57 e2e checks passing |
| Cloud provider | **GCP** — Cloud Run + Cloud SQL (D26) |
| Container registry | Artifact Registry |
| Compute target | Cloud Run, 1 instance, session affinity (D27) |
| Database | Cloud SQL PostgreSQL 16, private IP, connector socket |
| CI/CD provider | GitHub Actions (D28) |
| Secrets | Secret Manager, injected as env at deploy (D29) |
| Log destination | stdout → Cloud Logging (Pino JSON with `severity`) |
| API/WS contract | Frozen in `docs/api/` |
| Auth mechanism | HS256 session token (D8) |
| Health/readiness shapes | Defined and tested (D32) |
| CORS origins | Allowlist; empty in production = deny all (D23) |
| Single vs clustered | **Single instance**, deliberately (D27) |

---

## 2. Deployment architecture

```
                     Internet
                        │
                        ▼
        ┌───────────────────────────────┐
        │  Cloud Run (managed)          │
        │  • TLS terminated             │
        │  • WebSocket upgrade built in │
        │  • session affinity on        │
        │  • min=1  max=1               │
        │  • request timeout 3600s      │
        │  • CPU always allocated       │
        └───────────────┬───────────────┘
                        │ Cloud SQL connector (unix socket)
                        ▼
        ┌───────────────────────────────┐
        │  Cloud SQL · PostgreSQL 16    │
        │  private IP, no public access │
        │  daily backup + PITR          │
        └───────────────────────────────┘

  Secret Manager ──(env at start)──► Cloud Run
  Artifact Registry ──(image)──────► Cloud Run
  stdout ───────────────────────────► Cloud Logging
```

**Why Cloud Run and not GKE or a VM.** WebSockets need TLS termination that
forwards the upgrade and a request timeout longer than a spin. Cloud Run does
both with two flags; a VM would mean running and patching nginx, and Kubernetes
is explicitly out of scope. It also runs the Docker image the assessment already
requires, so there is one artifact rather than two.

**Four settings that are not defaults and matter:**

| Setting | Why |
|---|---|
| `--timeout 3600` | The default 5 minutes would cut a WebSocket mid-spin. |
| `--session-affinity` | Pins a client to the instance holding its socket. |
| `--no-cpu-throttling` | The spin scheduler ticks between requests. Throttled CPU makes eliminations land late. |
| `--min-instances 1` | A cold start during a running spin would delay ticks. |

---

## 3. Docker

Multi-stage (`/Dockerfile`), built from the **repository root** — the image needs
both `backend/` and `database/migrations`, so a revision can never start against
a schema older than its code.

| Property | Value | Reason |
|---|---|---|
| Base | `node:22-alpine` | Small, current LTS |
| Stages | deps → build → prod-deps → runtime | No compiler or dev deps in the final layer |
| User | `node` (uid 1000) | Nothing here needs root |
| Init | `tini` | Reaps zombies and forwards SIGTERM so graceful shutdown runs |
| Healthcheck | `wget /health` | Liveness only — never the database (D32) |
| Migrations | copied in | A revision migrates itself at boot |

**Verified:** image builds, runs under `docker compose`, reports healthy, and
passes all 57 e2e checks.

---

## 4. CI/CD

`.github/workflows/ci-cd.yml`.

```
install → typecheck → migrate → test (90)
        → build image → e2e against the image (57)
        → [main only] push → deploy → verify live → roll back on failure
```

**Rules, enforced not documented:**

- Failing tests never deploy — `deploy` has `needs: test`.
- Tests run against a **real Postgres** service container. A mocked database
  would reproduce none of the partial unique indexes, row locks or `SKIP LOCKED`
  behaviour the spin engine depends on, so a green mock suite would prove nothing.
- The image is e2e-tested in CI before it can be pushed.
- Deploy is gated on `refs/heads/main` and `push`.
- **Post-deploy verification is functional, not a health ping.** It runs the same
  `tests/e2e/verify.mjs` against the live URL — rooms, events, a complete spin,
  persistence, reconnect.
- Failure triggers an automatic `update-traffic` back to the revision captured
  *before* the deploy.
- No long-lived service-account key: Workload Identity Federation.
- Images are tagged with the commit SHA, not only `latest`, so a rollback has an
  immutable target.

### Required GitHub secrets and variables

| Name | Kind | Value |
|---|---|---|
| `GCP_PROJECT_ID` | secret | Project id |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | secret | `projects/N/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | secret | Deployer SA email |
| `GCP_SQL_INSTANCE` | secret | `project:region:roxstar-postgres` |
| `GCP_REGION` | variable | e.g. `europe-west1` |

---

## 5. Environment contract

Names only. Values come from Secret Manager or the deploy command; nothing
secret is in the repository (`.gitignore` covers `.env`, `*.tfstate`,
`terraform.tfvars`, keystores and credential JSON).

| Variable | Source | Required | Note |
|---|---|---|---|
| `NODE_ENV` | deploy | yes | `production` |
| `PORT` | Cloud Run | yes | Injected. Binding elsewhere fails health checks. |
| `DATABASE_URL` | **Secret Manager** | yes | Cloud SQL socket form |
| `DATABASE_SSL` | deploy | no | `false` — the connector handles TLS |
| `AUTH_SECRET` | **Secret Manager** | yes | ≥16 chars; **startup refuses the dev default in production** |
| `CORS_ALLOWED_ORIGINS` | deploy | no | Empty = deny all browser origins |
| `LOG_LEVEL` | deploy | no | `info` |
| `SPIN_*`, `PRESENCE_*`, `RATE_LIMIT_*` | deploy | no | Documented in `backend/.env.example` |

**Startup validates all of it and exits non-zero on anything invalid.** Cloud Run
will not route traffic to a container that exits, so a misconfigured deploy fails
closed instead of serving broken requests.

---

## 6. Secrets handling

- Generated with `openssl rand`, written to Secret Manager **via stdin** — never
  as a command-line argument, which would land in shell history and the process
  table.
- The runtime service account holds exactly two grants: `secretAccessor` on those
  two secrets, and `cloudsql.client`. Nothing else.
- Cloud Run mounts them as env vars at start; they are never baked into the image.
- Pino redacts `authorization`, `token`, `password` and `DATABASE_URL`, so a log
  sink — which typically has broader read access than the database — cannot leak
  them.
- Rotation: add a new secret version, redeploy. `AUTH_SECRET` rotation invalidates
  live sessions; users re-enter a display name, which is one tap and no password.

---

## 7. Health, verification and rollback

| Endpoint | Checks | Used by |
|---|---|---|
| `/health` | Process only | Cloud Run probes, Docker HEALTHCHECK |
| `/ready` | `SELECT 1` + migration state | Deploy gate, manual checks |

Liveness deliberately excludes the database: a probe that fails during a Cloud
SQL blip would restart every container, turning a brief degradation into an
outage.

**Rollback** — `infrastructure/gcp/rollback.sh`, or automatically in CI:

```bash
gcloud run services update-traffic roxstar-backend --to-revisions <previous>=100
```

Cloud Run keeps every revision, so rollback is a traffic switch — seconds, no
rebuild. Note that it does **not** revert a migration; migrations here are
additive, and a destructive one would need a paired down-migration and a
deliberate plan.

---

## 8. What was actually verified

Reporting this precisely matters more than reporting it favourably.

### Verified by execution

| Check | Result |
|---|---|
| Docker image builds from a clean context | PASS |
| Container starts and reports healthy | PASS |
| Migrations apply on boot | PASS — 2 applied |
| `/health` responds | PASS |
| `/ready` confirms the database and migration state | PASS |
| WebSocket connects and authenticates | PASS |
| Full journey: room → draft → spin → winner → persisted | PASS |
| Elimination pacing | PASS — 10 405 ms for 3 players |
| Reconnect recovery | PASS |
| Expected-failure handling | PASS |
| **57 e2e checks against the running container** | **57/57 PASS** |
| **90 backend tests** | **90/90 PASS** |
| Restart recovery, observed live | PASS — a fresh container picked up a `RUNNING` spin left in the database and completed it on its first tick |

### NOT verified

| Item | Why |
|---|---|
| **Cloud Run deployment** | No GCP credentials in this environment. Deploying to a real cloud account is the user's call, not something to do unprompted. |
| Live HTTPS/WSS endpoint | Follows the deploy |
| Cloud SQL connectivity | Follows the deploy |
| CI pipeline execution | Needs a GitHub repository and the secrets above |
| APK against the deployed backend | NDK not installed; deploy not done |

**`DEPLOYMENT_VERIFICATION.md` therefore records the local verification only,
and says plainly that the cloud deployment has not happened.** Writing anything
else would be the exact failure the PDF warns about — declaring success because
something uploaded.

---

## 9. To deploy

```bash
# 1. Infrastructure
cd infrastructure/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in; gitignored
terraform init && terraform apply

# or, without Terraform
export GCP_PROJECT_ID=your-project
./infrastructure/gcp/deploy.sh

# 2. VERIFY -- uploading is not deploying
cd tests && npm ci
node e2e/verify.mjs https://roxstar-backend-xxxxx.a.run.app

# 3. Only if that prints "VERIFIED", point the APK at it
#    android-app/gradle.properties:
#      ROXSTAR_API_BASE_URL=https://roxstar-backend-xxxxx.a.run.app
cd android-app && ./gradlew assembleRelease
```

Step 2 is not optional. The whole point of `verify.mjs` is that it exercises the
real journey from outside the process, and it is the same script CI runs.

---

## 10. Risks

| Risk | Mitigation | State |
|---|---|---|
| Deploy succeeds, app broken | Functional e2e post-deploy, auto-rollback | Implemented |
| WebSocket broken behind the proxy | `--timeout 3600`, session affinity; e2e opens a real socket | Implemented, locally verified |
| APK points at localhost | `verifyReleaseEndpoint` **fails the build** | Implemented |
| Secrets leaked in CI logs | Secret Manager, stdin only, redaction | Implemented |
| Duplicate spin timers when scaled | `max-instances=1`; the timer is already DB-claimed and safe either way | Accepted, documented |
| Cold start delays a tick | `min-instances=1`, `--no-cpu-throttling` | Implemented |
| Migration failure mid-deploy | One transaction per file, advisory lock, container exits on failure | Implemented |
| Rollback does not revert schema | Migrations are additive; a destructive one needs a paired down-migration | Accepted, documented |
| `spin_events` growth | Cleanup query documented | Accepted |
| Rate limiting is per-instance | Correct at one instance; needs a shared store if scaled | Accepted, documented |

---

## 11. Status

```
DEVOPS STATUS: ASSETS COMPLETE — LOCALLY VERIFIED — CLOUD DEPLOY PENDING CREDENTIALS

DELIVERED:
  Dockerfile (multi-stage, non-root, healthcheck)   built and run
  docker-compose.yml                                 verified
  GitHub Actions pipeline                            written, not executed
  Terraform for GCP                                  written, not applied
  gcloud deploy + rollback scripts                   written, not run
  Environment contract + secrets handling            implemented, tested
  Out-of-process verification suite                  57/57 against the container

NOT DONE (and why):
  Cloud deployment    no GCP credentials; deploying to a real account
                      needs the user's authorisation
  Demo recording      needs a device and a person
```

The honest summary: everything that can be verified without a cloud account and
an Android device **has been verified by running it**. The rest is written,
reviewed, and one command away.
