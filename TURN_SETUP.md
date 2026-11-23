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

Rejected candidates stay distinct from applied candidates. `InvalidStateError` is retried through bounded signaling backoff, up to three applications per candidate. A permanent failure or exhausted retry is recorded and skipped so later candidates can still connect. Duplicate accepted and rejected candidates are suppressed. The existing ten-second disconnection grace period remains active.

## Automated verification

```sh
node --test qa/*.test.cjs
node qa/browser-recovery.mjs
```

The browser command requires Chrome and a disposable local PHP/MySQL deployment at `http://127.0.0.1:8137`. Unit tests use mocked provider responses and RTC statistics for direct/relay selection, request/body timeouts, cancellation, rejection and reconnection. These tests do not establish that a live TURN account or a physical device pair works.

## Physical-device acceptance

Run every row with current browser versions and both devices awake. Record versions, network, role, TURN outcome, selected route, file size and downloaded SHA-256. Repeat sender/receiver roles for Safari.

| Pair | Network | Check |
|---|---|---|
| Desktop Chrome ↔ laptop Chrome | Ordinary Wi-Fi | Pair, exchange chat, accept a file, verify download and completion ACK |
| Desktop Chrome ↔ laptop Chrome | Known working third-device hotspot | Confirm direct transfer remains available with TURN configured |
| iPhone Safari ↔ desktop Chrome | Ordinary Wi-Fi and hotspot | Repeat both directions, chat and verified download |
| iPhone Safari ↔ desktop Brave | Ordinary Wi-Fi and hotspot | Repeat both directions and capture selected route |
| Any pair that failed before | Hostel Wi-Fi | Enable credentials and confirm an actual selected `relay` pair when direct connectivity fails |

For each pair, also decline a file, cancel a transfer, reconnect after a dropped link, then transfer again in the same session where possible. Brief disconnections should recover within the grace period. Sustained failures should show failure and allow fresh pairing. Confirm shared text, names, queues, requests and previews still work.

On a disposable local test copy only, temporarily set `iceTransportPolicy` to `relay` to verify authenticated relay allocation and byte-identical delivery even if direct routes are available. Restore `all` immediately afterward and verify it before packaging. Record `relayed` in the selected-route report on both ends. There is no production relay-only switch.

Repeat once with an invalid credential-scoped key and once with the provider request blocked. Pairing must proceed with STUN after a bounded wait, with a sanitized fallback reason. Success then depends on a usable direct network path.

Live relay and physical-device acceptance are pending account configuration and access to the devices/network. Browser-security HTML responses from the signaling host must be diagnosed separately from ICE connectivity.
