# Optional TURN connectivity

Slipstream uses the existing Google STUN servers and `iceTransportPolicy: "all"`.
When configured, Metered/Open Relay adds relay candidates alongside direct candidates.
ICE selects the working route. Production never forces relay-only transport.

## Configure your account

1. Open the [Open Relay signup](https://www.metered.ca/tools/openrelay/) and select its free offering. Verify the quota and payment requirements in your account before activating credentials. This implementation provisions no resources or billing.
2. Copy your Metered domain, such as `your-app.metered.live`.
3. On the TURN credential row, choose **Get credential → Show API Key**. Use that credential-scoped key. The account-wide Secret Key belongs exclusively on a backend and must never enter these files.
4. Edit `js/turn-config.js` in the deployed frontend as follows.

```js
window.SLIPSTREAM_TURN_CONFIG = {
  domain: 'your-app.metered.live',
  apiKey: 'YOUR_CREDENTIAL_SCOPED_TURN_API_KEY'
};
```

The InfinityFree path is `htdocs/js/turn-config.js`. Use a bare hostname, with no scheme or path. Both values default to empty and keep direct/STUN pairing available. Keep real values out of commits. The configuration is public and browser users can inspect and reuse the credential, potentially consuming its relay quota. Rotate or revoke it through Metered when necessary.

The frontend calls `https://<domain>/api/v1/turn/credentials?apiKey=...` and validates the returned ICE servers. It uses the supplied UDP, TCP and TLS URLs and credentials without inventing endpoints. The request and JSON body share a four-second deadline. Network, HTTP, malformed-response, timeout and browser configuration failures fall back to the original STUN configuration. Leaving pairing aborts discovery. URLs and credentials are excluded from application diagnostic reports.

[Metered credential API](https://www.metered.ca/docs/turn-rest-api/get-credential/) · [Key scopes](https://www.metered.ca/docs/turn-rest-api/)

## Hosting and quota

Run `php deploy/package-infinityfree.php` for a fresh upload folder. It includes `turn.js` and `turn-config.js`. Preserve or re-enter the deployed credential configuration when updating from an empty template. Upload the contents to the existing domain document root and retain the deployed MySQL override.

As checked on 23 November 2026, Open Relay advertises 20 GB of free TURN usage per month. Confirm the actual allocation and expiration in your account. Free quota exhaustion, provider outages, blocked external requests and blocked relay traffic can prevent relaying. This project does not purchase additional capacity or upgrade plans. [Open Relay terms and advertised offering](https://www.metered.ca/tools/openrelay/)

Relayed files and messages use internet bandwidth and pass through a third-party server as DTLS-encrypted traffic. The provider can observe connection metadata and volume. PHP/MySQL continues to hold temporary signaling information. SHA-256 verification and completion acknowledgments run in the browsers for both transport paths.

## Diagnostics

Open **Diagnostics** during or after a pairing attempt, then download the connection report before refreshing or retrying. It records TURN discovery outcome, successful and rejected candidate applications, candidate types and connectivity-check counts.

`snapshot.selectedRoute` reports `direct`, `relayed`, or `unknown`, plus local and remote candidate types when available. Selection comes from the transport's `selectedCandidatePairId`, with an ICE-transport API fallback for browsers exposing that interface. A nominated or successful unselected pair never proves relay use. `unknown` means the browser has not exposed a selected pair. Reports describe the last observed route and retain the final snapshot after closure.

Rejected candidates stay distinct from applied candidates. `InvalidStateError` is retried through bounded signaling backoff, up to three applications per candidate. A permanent failure or exhausted retry is recorded and skipped so later candidates can still connect. Successful application means the browser accepted the candidate. Responses to connectivity checks and a selected pair provide evidence that traffic can pass.

The `stability2` export identifies local, NAT-traversed and relayed selected paths. A relay at either end counts as relayed. Candidate families (IPv4, IPv6 or mDNS) appear when the browser exposes them. Check both devices' reports for application errors, pair priorities, check responses, bytes, recovery duration and closure reason. An unavailable final sample is identified explicitly. Unanswered checks alone cannot distinguish Wi-Fi client isolation, multicast filtering, routing, browser privacy or packet loss.

After opening the channel, both peers continue at the existing polling cadence. After ten seconds a successful poll can stop polling once the local browser has finished gathering, outbound writes have been acknowledged and the remote end-of-candidates marker has been applied. A thirty-second ceiling covers missing end markers or stalled signaling. Reports record the stop reason, queued rows at cutoff and candidates gathered afterward. Established transfers continue across signaling shutdown.

## Connection recovery

Either ICE or peer disconnection starts one 30-second recovery window. Slipstream keeps the same data channel, transfer and backpressure state, and displays **Reconnecting…**. Recovery clears the deadline when the reported transport states are healthy. Native failure, channel closure or expiry ends the attempt. Retry starts fresh pairing. The previous Windows report showed the application closing a relayed connection ten seconds after disconnection, without a native failure. Thirty seconds allows a full ICE consent-expiry interval and fits within the normal 60-second transfer response deadline. Browser consent checks and TURN refresh are managed by the browser, with their own clocks. Suspending a browser can also delay JavaScript timers. [RFC 7675 §5.1](https://www.rfc-editor.org/rfc/rfc7675#section-5.1)

ICE restart would require a generation identifier, updated offers and answers, generation-specific candidate cursors, a restart initiator and signaling that survives session expiry. The existing database holds one temporary offer, answer and candidate list per role. Recovery uses the current ICE generation. A permanent loss requires a fresh session and a new transfer for incomplete files.

## Automated verification

```sh
node --test qa/*.test.cjs
node qa/browser-recovery.mjs
node qa/browser-recovery.mjs http://127.0.0.1:8137 --soak
```

The browser command requires Chrome and a disposable local PHP/MySQL deployment at `http://127.0.0.1:8137`. The optional soak run records the selected pair before and after five idle minutes between sharing operations. Unit tests use mocked provider responses and RTC statistics for direct/relay selection, request/body timeouts, cancellation, rejection and reconnection. Physical networks and live TURN require separate acceptance.

## Physical-device acceptance

Run every row with current browser versions and both devices awake. Record versions, network, role, TURN outcome, selected route, file size and downloaded SHA-256. Repeat sender/receiver roles for Safari.

| Pair | Network | Check |
|---|---|---|
| Desktop Chrome ↔ laptop Chrome | Ordinary Wi-Fi | Pair, exchange chat, accept a file, verify download and completion ACK |
| Desktop Chrome ↔ laptop Chrome | Known working third-device hotspot | Confirm direct transfer remains available with TURN configured |
| iPhone Safari ↔ desktop Chrome | Ordinary Wi-Fi, cellular data off | Repeat both directions, chat and verified download |
| iPhone Safari ↔ desktop Chrome | iPhone Personal Hotspot, laptop joined to iPhone | Repeat both directions and record route separately from third-device hotspot |
| iPhone Safari ↔ desktop Brave | Ordinary Wi-Fi and hotspot | Repeat both directions and capture selected route |
| Any pair that failed before | Hostel Wi-Fi | Enable credentials and confirm an actual selected `relay` pair when direct connectivity fails |

1. Open the same build on both devices. Create a code on one and join on the other. Confirm the channel opens on both and exchange a chat message in each direction.
2. Send a small file (e.g. 32 KiB), accept and download. Compare SHA-256 with the original (Windows: `Get-FileHash -Algorithm SHA256 <path>`). For Safari, save to Files and copy the download back independently for hashing. Confirm verified completion on both screens.
3. Leave the same session idle for five minutes. Send a message, then transfer a larger file (e.g. 8 MiB, maximum 100 MiB). Compare downloaded bytes or hashes again. Observe the session for up to ten minutes and export Diagnostics on both ends before exiting.
4. Between completed transfers, try a tab switch, background/foreground on iOS, screen lock/unlock and a brief Wi-Fi interruption, one at a time. Record the time of each action. After each, send another message and file if still connected. For a separate permanent-loss test, leave Wi-Fi off beyond 30 seconds after disconnection. An established workspace should return home with a notice and retain verified downloads. Restore Wi-Fi, pair again and finish with a normal end-session.
5. For a relay-outage test on an isolated test network under your control, first confirm a selected relay, then briefly interrupt access to its endpoints between transfers. Record whether ICE recovered, changed routes or ended the session. Blocking credential discovery only tests setup. If controlled network access is unavailable, mark the outage test pending.

For each run record device/browser versions, roles, network, build, pairing result, selected types at open and end, elapsed time, interruption times and outcomes, files attempted/completed, both hashes and final channel state. Include failed runs. A connected snapshot alone does not establish continuous uptime.

On a disposable local test copy only, temporarily set `iceTransportPolicy` to `relay` to verify authenticated relay allocation and byte-identical delivery even if direct routes are available. Restore `all` immediately afterward and verify it before packaging. Record `relayed` in the selected-route report on both ends. There is no production relay-only switch.

Repeat once with an invalid credential-scoped key and once with the provider request blocked. Pairing must proceed with STUN after a bounded wait, with a sanitized fallback reason. Success then depends on a usable direct network path.

The supplied older reports include a relay session that disconnected and another with six accepted remote candidates, a selected relay pair, an open channel and nine 701 events. The latter snapshot was taken 144 seconds after pairing began; its event log covers about 43 seconds. The user also reported successful Safari/Windows sharing over TURN and direct laptop sharing on a third-device hotspot. All physical rows require acceptance on the Phase 4 build.

## Reading a Phase 4 report

The export retains `build`, `snapshot` and `entries`. `openedAt` and `timeToOpenMs` record the first data-channel open. `reliability` counts interruptions and recoveries and records the most recent 20 durations and outcomes. `ongoingSince` identifies a recovery in progress and a closed snapshot has a `reason`. No ICE restart is attempted.

`candidateExchange` counts local POST attempts (including retries), acknowledgments, remote signaling rows received (including duplicates stored by the server), and candidate types. `applied` counts successful browser applications, `applyFailures` counts failed calls, and `rejected` counts distinct candidates permanently skipped. A deferred candidate retains its cursor and bounded retries while later candidates can be tried in the same poll. An end-of-candidates marker waits for unresolved earlier candidates.

`checks` timestamps a browser statistics sample and reports failed/observed pair counts. When the transport identifies its selected pair, the report includes available check and consent counters, RTT in seconds, state and byte counts. `lastKnownSelection` timestamps the latest known route even if a subsequent sample lacks a selected pair. Opening Diagnostics requests a sample without adding network polling. Browsers can omit fields.

`gatheringErrors` groups events by code, service, transport parameter, configured server slot (one-based) and browser message category. Counts and first/last timestamps survive event-log rotation. Up to 32 groups are retained. The configuration slot identifies a server entry without exposing its address; some entries contain multiple URLs. An unmatched URL has a null slot. Code 701 indicates an ICE server could not be reached from any local host candidate for that gathering operation. Other servers or routes can still work. Correlate the error times with open, selected-pair and recovery evidence; neither the old logs nor an error count identifies a faulty router or TURN allocation. [WebRTC gathering errors](https://www.w3.org/TR/webrtc/#rtcpeerconnectioniceerrorevent)

## Release and rollback

For a Phase 5 release, back up the matching HTML, stylesheet, application controller, text-sharing and WebRTC scripts. Upload the reviewed assets first and HTML last. For an older site, use the complete matching frontend from the package so the redesigned workspace and QR dependencies load together. Preserve the installed TURN configuration and MySQL override. Reload both devices in fresh sessions and confirm the report says `phase5`. Roll back using the matching backed-up frontend and pair again.
