# Reliability Validation - 2026-10-02

## Scope

This change set addresses observed session, report, transport, authorization and desktop interaction defects. It does not change model providers, simulation prompts, avatar bone control or corpus contents. Reaction planning and ADK execution rollout flags are not enabled by these changes.

- Session creation and accepted turns update the authority and legacy session record transactionally.
- Report generation reserves the session; concurrent turns/reviews are refused. Failed or expired reviews reopen the session. Successful reports are stored once and can be fetched again.
- Reset cancels pending turn/review reservations. Late results cannot commit to a reset session.
- Cancellation finishes the active response cleanup before the voice handler acknowledges it. Old playback completion/cancellation IDs cannot clear the active response. Disconnect clears queued utterances.
- Node authorizes decoded paths, including query strings and trailing slashes. Shutdown requires instructor identity at both Node and sidecar boundaries; Node also keeps its localhost restriction.
- Case selection now uses the loaded case list. Obsolete text/report responses cannot update a newly selected case. Submission/review controls use synchronous locks as well as visible disabled states.
- Startup and request failures preserve usable recovery controls. Same-text retries reuse the pending turn ID.

## Completed Checks

| Check | Result / coverage |
| --- | --- |
| `npm run build` | Passed; existing large Avatar chunk warning remains. |
| Node syntax / Python compilation / `git diff --check` | Passed. |
| `session:authority:test` | 10 tests: atomic commit, ownership, duplicate turns, 20-turn restart, concurrent reservations, reset, cancellation/commit race, report reservation and expiry recovery. |
| `session:api:test` | 7 tests: real ASGI routes and SQLite authority with stubbed generation, HTTP/WS ownership and projection, concurrent requests, report failure/retry, malformed payloads and sidecar shutdown protection. |
| `auth:boundary:test` | Real Node process with fake upstream: Basic/cookie access, invalid/expired cookies, trainee routes, encoded/query/trailing-slash paths, forged identity headers and WebSocket upgrades. |
| `desktop:session:test` | Headless Chrome against production build, mocked APIs: startup recovery, preserved input/turn ID, report lock and failure recovery, stale-case response rejection; 1280x720, 1440x900, 1920x1080 without horizontal overflow or clipped composer. |
| Desktop screenshots | Inspected 1280x720 and 1920x1080: John Do visible and upper-body framed, composer visible. All three screenshots generated under `/tmp/social-work-desktop-check/`. |
| `voice:stream:test` | Passed partial/final dedup, genuine repeated utterances, invalid audio/event recovery, interruption and subsequent-turn response. |
| Voice machine/audio/queue/boundary/client/policy | Passed; boundary test covers 24 simulated utterances; queue test covers 60 seconds of genuine silent frames. |
| Spoken-text/reaction-plan/ADK-runner contracts | Passed with fixtures/mocks, no live generation. |
| Avatar motion/lip/Streamoji | Passed existing regression scripts. Body animation was not changed in this round. |

Tests distinguish provider mocks from actual provider validation. `adk:smoke` initially stopped on a missing `copy` import before any model request; that import is fixed. The script now skips live execution unless `--allow-paid` is provided. No paid model/Google acceptance run was completed in this round.

## Remaining Acceptance Work

- Real Cantonese and English microphone sessions, ten turns each, including interruption, temporary network loss and Google stream rotation.
- Fly deployment verification: authentication, readiness, provider connectivity and cold-start recovery. This change set has not been deployed.
- PostgreSQL execution of the new report reservation schema/transactions; current transactional tests run on SQLite.
- Five-case paid comparison and human review of response realism/latency; no claim of improved clinical or simulation validity from these engineering tests.
- Dependency audit remediation: audit reported five transitive advisories (three high, two moderate). No dependency upgrades are included here.
- The delayed Avatar bundle is approximately 852 kB minified; further bundle/image size work is separate from this reliability fix.

## Reproduce

Build first, then run the offline scripts listed above. HTTP/WS and browser tests bind ephemeral loopback ports and clean up their temporary servers. The browser test requires an installed Chrome and Playwright; `PLAYWRIGHT_MODULE` accepts an existing module path. No real backend or provider is needed for these three new integration/browser scripts.

`npm run adk:smoke -- --allow-paid` and `npm run smoke:sessions` are live-provider actions, not default CI/deploy prerequisites. Keep experimental rollout flags disabled until their separate comparison is authorized and passed.
