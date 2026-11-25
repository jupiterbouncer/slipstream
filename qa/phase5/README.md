# Phase 5 connectivity and mobile evidence

## Physical evidence available before this change

The joiner's Phase 4 report from November 23 showed 9 local candidate POSTs acknowledged, 6 remote rows applied and 0 application failures. One accepted remote host candidate had an mDNS address. The sampled stats exposed remote IPv4 srflx and relay candidates. No sampled host/host pair appeared. A host/srflx pair sent up to 5 connectivity requests and received 0 responses. No sampled direct pair succeeded. The selected relay/srflx pair succeeded, the channel opened in 6.921 seconds, and the last selected RTT was 181 ms. The 42-second capture recorded no interruptions. Four 701 events involved TURN/TURNS over TCP.

This places the observed host/srflx issue at connectivity checks. The report cannot determine whether Wi-Fi isolation, firewall policy, mDNS resolution, NAT or another network condition caused it. It also cannot establish what the other endpoint gathered or why the browser omitted a host/host pair. A successful candidate application alone does not establish reachability. The route classification uses the browser's selected candidate pair. [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/#dom-rtcicetransportstats-selectedcandidatepairid)

## Reproduced application defects

- A ten-second timer aborted polling in the middle of a candidate POST on an already-open channel. A regression held that POST across the deadline and observed zero acknowledged rows on Phase 4. Phase 5 drains it on a successful poll. Delayed remote candidates still have a bounded exchange window. At the hard deadline inspect `candidateExchange.stopReason`, `pendingAtStop` and `gatheredAfterStop`.
- After accepting the remote SDP offer, a transient failure creating the answer left the joiner with a remote description. The next poll skipped answer creation, so the host could wait indefinitely. The new regression requires one applied offer and one posted answer following the retry.
- Neither reproduced failure explains the previously successful relay session by itself. Production retains the same STUN servers, optional Metered configuration, automatic route selection and recovery window.

## Reproduce the browser diagnostic

Start the local PHP/MySQL app on port 8137 as described in the README. Run `node qa/browser-recovery.mjs --stun-only`. The test sets an empty Metered configuration inside its two disposable Chrome profiles before either page loads. The production package contains no diagnostic switch. Both profiles must show precisely the two existing STUN servers, transport policy `all`, and a succeeded selected pair with two known non-relay candidate types before the offer and after download. The harness also exercises chat and compares downloaded bytes with the original. Omit the flag to exercise the normal deployment configuration. A local checkout with empty Metered settings cannot verify a live allocation.

The two same-computer Chrome endpoints each gathered, posted and applied two candidate rows in the direct-only run. Both selected host/host and reported responses to connectivity checks. The 1,048,577-byte download matched its original, SHA-256 `c14e31451fd78543de78b040414ae3a0f2bae364cfd0e483873bf55e896d36da`.

All 55 baseline automated tests passed on Phase 4. All 58 passed on Phase 5, including three new signaling regressions. The packaged app also passed the two-browser suite with its normal local configuration and in STUN-only mode.

## Separate-device acceptance

Use a trusted HTTPS development copy. The checked-in empty `turn-config.js` is the STUN-only configuration. Use a separate normal copy with the existing Metered configuration. Refresh both devices and create a fresh session per run. Start on ordinary Wi-Fi. On each endpoint export the sanitized connection report after a message exchange and SHA-256 verified download, or immediately after failure. Record the network, roles, build, selected types and transfer result. Classify a route with either candidate of type relay as relayed. If the reports show accepted host candidates without responses, compare the same devices on the hotspot before attributing the failure to a specific network setting.

| Physical pair | Network and mode | Evidence still needed on Phase 5 |
| --- | --- | --- |
| Windows Chrome / iPhone Safari | Ordinary Wi-Fi, STUN-only then normal | Both reports and verified file in each mode |
| Chrome laptop / Chrome laptop | Ordinary Wi-Fi, then third-device hotspot, both modes | Direct transfer and selected pair per network. Direct hotspot transfer was previously user-reported. |
| Windows Brave / iPhone Safari | Ordinary Wi-Fi, both modes | Compare with Windows Chrome on the same Wi-Fi |
| Windows laptop / iPhone Safari | Different networks, normal configuration | Verified transfer and selected path. A relay result confirms fallback for that run. |

Physical devices were unavailable for this phase. No existing report was uploaded to the repository.

## Mobile review

| View at 390 × 844 | Before | After |
| --- | --- | --- |
| Files | [Files before](before/files.png) | [Files after](after/files.png) |
| Messages | [Messages before](before/messages.png) | [Messages after](after/messages.png) |
| Settings | [Settings before](before/settings.png) | [Settings after](after/settings.png) |
| Activity | [Activity before](before/activity.png) | [Activity after](after/activity.png) |

Screenshots use synthetic content. Chrome coverage includes navigation and its active ring, actual nicknames, link wrapping, multiline text, settings validation and transient confirmation, requests, previews, verified downloads, QR recognition with a synthetic camera feed, focus restoration and reduced motion. The responsive matrix covers 320, 360, 375, 390, 430, 768 and 1280 CSS pixels. A shortened viewport and landscape exercise composer access. Native iOS keyboard, camera, VoiceOver and physical connectivity still need device testing.
