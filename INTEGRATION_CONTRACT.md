# INTEGRATION_CONTRACT.md

**Purpose:** compare the implemented client and the implemented backend, interface by interface, and record every remaining mismatch.
**Auditor:** Senior Full Stack Integration Developer
**Verdict:** **INTEGRATED — contracts match**

> The plan-stage version of this document listed 30 rows, of which **0 matched**,
> because no contract existed. This is the re-run against real code.

---

## 1. Contract comparison

Every row was checked against `docs/api/openapi.yaml` (the frozen contract),
`backend/src/models/dto.ts` and `android-app/.../data/api/Dtos.kt`.

| # | Interface | Client | Backend | Match |
|---|---|---|---|---|
| 1 | REST base path | `/api/v1` | `/api/v1` | YES |
| 2 | Auth header | `Authorization: Bearer` | same | YES |
| 3 | Error envelope | `{error:{code,message,details?},requestId}` | same | YES |
| 4 | Create room | `POST /rooms` → 201 | same | YES |
| 5 | Join room | `POST /rooms/{idOrCode}/join` → 200 | same | YES |
| 6 | Leave room | `POST /rooms/{id}/leave` → 200 | same | YES |
| 7 | Room state | `GET /rooms/{id}/state` | same | YES |
| 8 | **Share draft** | `{draftId,name,durationMs,effect,hostedFileUrl:null}` | same, metadata-only | **YES — C1 resolved** |
| 9 | Start spin | `POST /rooms/{id}/spin/start` → 201 | same | YES |
| 10 | Get spin | `GET /rooms/{id}/spin` | same | YES |
| 11 | Health / ready | not polled by the client | `/health`, `/ready` | YES |
| 12 | Socket namespace | `/rooms` | `/rooms` | YES |
| 13 | **Handshake auth** | `auth.token` | reads `auth.token`, falls back to the header | **YES — C2 resolved** |
| 14 | `user_joined` | `{participant, participants}` | same | YES |
| 15 | `user_left` | `{userId, reason, participants}` | same | YES |
| 16 | `draft_shared` | `{sharedDraft}` | same | YES |
| 17 | `spin_started` | `{spin}` | same | YES |
| 18 | `user_eliminated` | `{eliminatedUserId, eliminatedDisplayName, eliminationOrder, reason, remainingParticipants, spin}` | same | YES |
| 19 | `winner_announced` | `{winner, spin}` | same | YES |
| 20 | `room_state` | full `RoomStateDto` | same builder as REST | YES |
| 21 | **`eventId` dedupe** | bounded 256-id window | UUID v4 on every event | **YES — C7 resolved** |
| 22 | **Idempotency transport** | `Idempotency-Key` header | reads it, stores per user+endpoint | **YES — C5 resolved** |
| 23 | **Reconnect sequencing** | client re-emits `subscribe_room` | server replies `room_state` | **YES — C6 resolved** |
| 24 | **Disconnect grace period** | renders "reconnecting" | 15 s, then `user_left` | **YES — C8 resolved** |
| 25 | **Leave during a spin** | renders `reason: LEFT` as "forfeited" | forfeits, assigns order | **YES — C3 resolved** |
| 26 | **Owner disconnects** | nothing special; spin keeps running | spin continues, no transfer | **YES — C3 resolved** |
| 27 | **Server restart** | reconnects, takes `room_state` | resumes from the persisted deadline | **YES — C3 resolved** |
| 28 | **Delayed timers** | no local timer to desync | re-anchors beyond 15 s lag | **YES — C3 resolved** |
| 29 | **Draft audio transport** | never uploads | never hosts | **YES — C1 resolved** |
| 30 | **Winner selection rule** | client never decides | `crypto.randomInt`, persisted | **YES — resolved** |
| 31 | `spin_aborted` (new) | handled | emitted on `NO_PARTICIPANTS` | YES |

**31 of 31 match.** All eight critical mismatches (C1–C8) are closed.

---

## 2. How each blocker was closed

| Blocker | Resolution | Evidence |
|---|---|---|
| **C1** Draft sharing ambiguity | D10: metadata only. `hostedFileUrl` accepted, nothing hosted. | e2e asserts no audio in any payload |
| **C2** Authentication undefined | D8: anonymous device-bound HS256 session, same token on REST and the handshake | 401 tests on both transports |
| **C3** Spin edge-case rules | D11/D12/D14/D15 decided, implemented, tested | 18 concurrency tests |
| **C4** Payload schemas unfrozen | `docs/api/openapi.yaml` + `websocket-events.md`; DTOs mirror them | 12 websocket tests |
| **C5** Idempotency informal | D18: `Idempotency-Key`, per user+endpoint, 24 h TTL, replay or 409 | replay and reuse both tested |
| **C6** Reconnect sequencing | D19: one path — subscribe, then `room_state` | reconnect-mid-spin test |
| **C7** `eventId` not adopted | Client dedupes on a bounded window | uniqueness asserted |
| **C8** Grace period undefined | D13: 15 s, configurable; distinct `user_left` reason | grace-expiry test |

---

## 3. Mismatch found during integration

One real defect, and it was only findable by crossing the process boundary.

**`POST /leave` returned 400 from a real HTTP client.**

- **Affected side:** backend.
- **Root cause:** Fastify's default JSON parser rejects an empty body when the
  client still sends `Content-Type: application/json`. Retrofit and `fetch` both
  do that on a POST with no payload. The backend's in-process tests passed
  because `app.inject()` omits the header.
- **Symptom on device:** the Leave button silently does nothing.
- **Fix:** a content-type parser that treats an empty body as `{}`, while still
  returning a clean 400 for genuinely malformed JSON. Assigned to backend, since
  making the client send a pointless `{}` literal would be papering over it.
- **Requirement changed:** none, so no escalation was needed.
- **Regression cover:** two tests added to the in-process suite.

This is the entire justification for running an out-of-process e2e suite
alongside unit and integration tests.

---

## 4. Gaps against Tech Manager requirements

The plan-stage audit listed six. Current status:

| Requirement | Then | Now |
|---|---|---|
| At least 3 edge cases demonstrated | MISSING | **10 implemented and tested** |
| Architecture diagrams | MISSING | **5 Mermaid diagrams in `docs/architecture/`** |
| Docker packaging | PARTIAL | **Built, run, verified** |
| CI/CD | MISSING | **GitHub Actions: test → build → deploy → verify → roll back** |
| Cloud deployment | MISSING | **Assets complete; not executed — no credentials** |
| Demo recording | MISSING | **Still missing — requires a device and a person** |

---

## 5. End-to-end verification

The full journey the PDF describes was executed against the containerised stack:

```
record → effect → draft → create room → join → share draft
      → start spin → eliminate every 5s → winner → persisted → retrieved
```

**57 of 57 checks passed** (`tests/e2e/verify.mjs`), including reconnect
recovery, expected-failure handling and departure handling. Measured pacing:
10 405 ms for a 3-player spin, against an expected 10 000 ms.

The audio half of that journey is verified separately by the 45 host-compiled
DSP tests, because it needs no server — and, being local by design, no server
can verify it.

---

## 6. Integration decision

**INTEGRATED.**

Contracts match on all 31 interfaces. The one mismatch found was a backend
defect, fixed within the audit, with regression cover added. No requirement was
altered, so nothing needed escalation to the Tech Manager.

### Remaining work, owned and named

| Item | Owner | Blocker |
|---|---|---|
| Build the release APK | Full Stack | No Android NDK in this environment |
| Deploy to Cloud Run | DevOps | No GCP credentials; requires the user's authorisation |
| Verify the live endpoint | DevOps | Follows the deploy — `node tests/e2e/verify.mjs <url>` |
| Record the 5–10 minute demo | Candidate | Needs a device and a person |

None of these is blocked by code. Each is blocked by something this environment
does not have, and each is stated rather than glossed over.
