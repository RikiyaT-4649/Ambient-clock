# Continuous-operation improvements

The changes below address the twenty items from the stability audit. A browser or OS can still suspend or discard a page; the application resumes/reconstructs its state rather than promising background execution.

| # | Implemented change | Verification |
|---|---|---|
| 1 | Request deadline covers headers and JSON body; legacy XHR path has a timeout too. | Unit tests; real HTTP stream that stops mid-body. |
| 2 | Expired attempts can be aborted/replaced; only the current attempt may commit a result. | Suspended request and late-result tests. |
| 3 | First load and retries share data publication and visible weather/city updates. | Initial HTTP 503 followed by success in Chrome. |
| 4 | Alarm/work timer uses a nonblocking, dismissible notice instead of alert(). | Clock continues while notice is visible. |
| 5 | navigator.onLine never gates fetching. | Offline hint with a successful transport. |
| 6 | GPS has a separate ten-second fallback; reverse geocoding does not block weather. | Unresolved GPS and city lookups. |
| 7 | Three forecast days are selected by location date; stale/missing sun times use a labelled estimate. | Simulated 72-hour outage and recovery. |
| 8 | Frame exceptions are caught; retries back off and quality is lowered. | Injected cloud-render failure. |
| 9 | pageshow, visibilitychange, resume and online resynchronize state; requests coalesce. | Lifecycle/event burst tests. |
| 10 | Weather numbers, codes, timezone, sun arrays and dates are validated. | Invalid/missing/null/range cases. |
| 11 | Source observation time is checked, independent of download time. | Stale/future/older result rejection. |
| 12 | Transport commits before optional presentation; visual errors do not trigger transport retries. | Failed presentation with successful transport. |
| 13 | Recovery events can bypass normal backoff, with a one-minute probe limit. | Reconnect and event-burst tests. |
| 14 | Exponential backoff/jitter and Retry-After handling for 429/503. | Rate-limit waiting test. |
| 15 | Wall/monotonic clock discontinuities reset due checks; backward clock correction releases stale comparison state. | Clock correction test. |
| 16 | Validated last weather/location is restored from a versioned local cache, up to six hours old; live refresh still runs. | Cache rejection/restoration and browser reload. |
| 17 | Main Canvas restoration rebuilds transforms/textures; an independent heartbeat retries graphics; star textures have a 384-entry limit. | Context-restored event and texture bound tests. |
| 18 | Weather startup is registered before graphics initialization; failed Canvas contexts use a static fallback. | All Canvas contexts forced unavailable while weather/clock continue. |
| 19 | Wake Lock UI reflects an actual lock, not intent; release/failure/timeout retry with backoff and stale-result protection. | Rejected lock, successful retry and system release. |
| 20 | Work timer uses a deadline; alarm checks crossed deadlines; timer/alarm state is saved locally. | Time jumps, notification and reload tests. |

The information panel shows observation age, connection state, retry state and estimated sun times. `ambientDiagnostics()` in the developer console returns bounded diagnostic events; transport event kinds contain no coordinates or request URLs. The last ten transport event kinds/timestamps are retained locally, at most once per minute.

## Reproduce checks

From the repository root:

```sh
node --test Ambient_clock/tests/reliability.test.cjs
node Ambient_clock/tests/stability-browser.cjs
```

The browser check requires Playwright and installed Google Chrome. `PLAYWRIGHT_MODULE` can point to an existing module. It starts an ephemeral loopback-only fault server and closes it afterwards. The separate `browser-smoke.cjs` checks all visual previews against a running app server.

Time jumps simulate dates/suspension. They do not establish actual multi-day battery consumption, thermal stability, GPU-driver recovery on every device, or memory behavior on physical older phones. Real-device soak testing remains necessary. On browsers without Canvas loss events, periodic heartbeat/context reacquisition is a best-effort fallback.
