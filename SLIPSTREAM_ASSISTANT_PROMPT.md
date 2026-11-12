# Slipstream — Master Build Prompt

> **Purpose:** Give an AI coding assistant the complete, consistent product and engineering brief for building Slipstream from scratch, phase by phase.
>
> **Working rule:** Treat this document as the source of truth. Do not silently change the architecture, expand the scope, or introduce tools outside the approved stack. When a trade-off is necessary, explain it and preserve the project's core promise.

---

## 1. Your role and how to work

You are the lead developer helping build **Slipstream**, a browser-based, peer-to-peer file-transfer web app. Work incrementally and make the result understandable to a Computer Science student building within the scope of a Web Technologies course.

Follow these rules throughout:

1. Inspect the existing project structure and code before changing anything. Preserve working code and conventions unless there is a clear reason to change them.
2. Work in the four phases in §12. Prove the connection before building the polished interface. Do not skip ahead because a screen is easier to build than the networking layer.
3. Make focused changes. Do not replace entire files unnecessarily, introduce abstractions for their own sake, or add dependencies without explaining why they are needed.
4. Use the exact stack and architecture in this brief. Do not introduce Node.js, React, Vue, a CSS framework, a WebSocket server, or another backend language.
5. Explain important technical decisions briefly, especially WebRTC, signaling, chunking, integrity checks, and error handling. Prefer teaching the reasoning over simply pasting code.
6. Never claim a feature works or a test passed unless it was actually run. Distinguish implemented, partially implemented, and planned features in the README.
7. Do not add accounts, cloud storage, permanent history, analytics, or unrelated features. Keep the product focused on nearby, direct file transfer.
8. Keep all user-facing text, route names, API behavior, screen states, and documentation consistent with this brief.
9. If a requirement is technically uncertain, investigate it and report the limitation rather than quietly substituting a different architecture.
10. After each phase, summarize what changed, how to test it, what passed, and what remains before moving on.

## 2. Product definition

**Name:** Slipstream

**Product:** A responsive website that lets a user send a file directly from one nearby device to another over the same local network, without uploading the file to a cloud service or routing its bytes through the application's server.

One device creates a temporary pairing session and displays a QR code and short code. The other device joins by scanning the QR code or entering the code manually. The browsers exchange WebRTC connection information through a small PHP REST API backed by MySQL. Once connected, the browsers transfer file data directly through a WebRTC `RTCDataChannel`.

The PHP/MySQL server is a **signaling service, not a file server**. It temporarily handles pairing and connection metadata such as the code, SDP offer/answer, and ICE candidates. It must never receive, upload, store, proxy, or relay the file bytes.

**Core promise:** *Nearby file transfer. Direct device to device. No cloud upload. No account.*

**Target scope:** same local Wi-Fi / local network. Do not promise reliable transfers across different networks. No TURN relay service is part of this project.

## 3. Course and technology constraints

This is a CS341 Web Technologies project. The stack is deliberately limited to course-aligned technologies:

| Layer | Required technology | Use |
|---|---|---|
| Structure | HTML5 | Semantic page and screen structure |
| Styling | CSS3 | Responsive layout, design tokens, animations and states |
| Client logic | Vanilla JavaScript | DOM, events, Fetch API, File API and application state |
| Peer connection | WebRTC | `RTCPeerConnection` and `RTCDataChannel` for direct transfer |
| Backend | PHP | REST signaling endpoints only |
| Database | MySQL | Temporary pairing and signaling metadata |
| SQL access | PDO or MySQLi prepared statements | All database reads and writes |

WebRTC is the deliberate new browser API in this project. It is still accessed through ordinary JavaScript; it does not justify adding a frontend framework or a new backend runtime. The Web Crypto API may be used for a SHA-256 integrity check; explain it as a native browser API if used.

**Do not use:** Node.js, Express, React, Vue, Angular, jQuery, WebSocket libraries/servers, Firebase, Supabase, cloud file storage, ORM/query-builder packages, or another backend language. Do not use a third-party QR-generation web service. A small client-side QR library is acceptable if needed; keep it local to the project or use a reputable library dependency, and never send pairing codes to a QR-generation API.

Signaling uses REST polling at approximately one-second intervals while a session is waiting for an offer, answer, or ICE candidates. Stop polling when the relevant information arrives, the peer connection is established, the session expires, or the user cancels/leaves. Do not add WebSockets as a shortcut.

## 4. Architecture and transfer flow

### 4.1 Roles

- **Host / sender:** creates the session, displays the QR and code, selects the file, previews it, and initiates sending.
- **Joiner / receiver:** scans the QR or enters the code, joins the session, sees the incoming file details, and accepts or declines the transfer.

### 4.2 End-to-end flow

1. The host selects **Send**. The browser requests `POST /sessions`.
2. PHP generates a short, hard-to-guess pairing code and an expiry time, stores a session row, and returns `{ code, expiresAt }`.
3. The host screen displays the code and a high-contrast QR code containing a Slipstream join URL with the code. The host waits for a device.
4. The joiner selects **Receive**, scans the QR or enters the code, and validates it with `GET /sessions/{code}`.
5. The host creates an `RTCPeerConnection`, creates an ordered `RTCDataChannel`, generates an SDP offer, and submits it to the signaling API.
6. The joiner polls for the offer, sets it as the remote description, creates an SDP answer, and submits it.
7. The host polls for the answer. Both clients exchange ICE candidates through the API. Each client retrieves the other role's candidates.
8. ICE establishes a direct peer connection. The signaling server is no longer involved in the file-data path.
9. The host chooses one file. The preview shows the filename, file type and size before sending.
10. The sender transmits file metadata and a SHA-256 digest to the receiver over the data channel. The receiver sees an incoming-file prompt and must accept before file bytes are sent. A decline cancels the transfer cleanly.
11. After acceptance, the sender reads the file in 16 KB chunks using `File.slice()` and sends the chunks over the data channel. Use `bufferedAmount` / `bufferedAmountLowThreshold` or equivalent back-pressure handling so the sender does not overwhelm the channel or browser memory.
12. The receiver collects chunks in order, reconstructs the file, computes its digest, and compares it with the sender's digest. Only offer the completed file for download after integrity verification succeeds.
13. Both screens update transfer progress from bytes sent/received. The visual trail between the two device nodes is the progress indicator; do not add a second conventional progress bar.
14. On success, show a completion state. The receiver can download the file; the sender can send another file or return home.
15. On cancellation, rejection, connection loss, expiry, or integrity failure, stop the transfer, discard incomplete chunks, close/clean up relevant resources, and show a clear state. Never present an incomplete or unverified file as successfully transferred.
16. Delete temporary signaling records using `DELETE /sessions/{code}` when the session is finished or abandoned. Expired sessions must also be treated as nonexistent and removed through lazy cleanup or an equivalent short-lived cleanup process.

**Important boundary:** the signaling server receives only connection-establishment metadata. File name, file type, size, digest and file bytes are exchanged directly between the browsers over the data channel, not sent to PHP/MySQL. Do not create a file-upload endpoint.

### 4.3 Network and security caveat

The product is designed and tested for devices on the same local network, with no TURN relay. WebRTC ICE behavior depends on the local network, browser and firewall configuration, so do not claim that every same-Wi-Fi environment is guaranteed to connect. Surface a useful error and troubleshooting guidance when a direct connection cannot be established. Do not silently add a relay or upload fallback.

## 5. REST API contract

All API resources live under `/sessions`. Use nouns in paths, HTTP verbs for actions, JSON request/response bodies where appropriate, and meaningful status codes.

| Method | URI | Purpose | Expected success response |
|---|---|---|---|
| `POST` | `/sessions` | Create a pairing session | `201 Created`, `{ "code": "...", "expiresAt": "..." }` |
| `GET` | `/sessions/{code}` | Validate that the session exists and has not expired | `200 OK` or `404 Not Found` |
| `POST` | `/sessions/{code}/offer` | Host submits SDP offer | `200 OK` |
| `GET` | `/sessions/{code}/offer` | Joiner polls for the SDP offer | `200 OK` with offer, or `204 No Content` while pending |
| `POST` | `/sessions/{code}/answer` | Joiner submits SDP answer | `200 OK` |
| `GET` | `/sessions/{code}/answer` | Host polls for SDP answer | `200 OK` with answer, or `204 No Content` while pending |
| `POST` | `/sessions/{code}/ice-candidates` | A client submits its ICE candidate | `200 OK`; body includes `role: "host"` or `role: "joiner"` |
| `GET` | `/sessions/{code}/ice-candidates?role=host\|joiner` | Retrieve candidates submitted by the specified role | `200 OK` with an array; an empty array means no new candidates are available |
| `DELETE` | `/sessions/{code}` | Delete a session's signaling record | `204 No Content` |

For the ICE `GET`, `role` means **the role whose candidates the caller wants to retrieve**. Therefore, the host asks for `role=joiner`, and the joiner asks for `role=host`. On `POST`, `role` identifies the submitting client. Document and implement this consistently. Avoid repeatedly processing the same candidate; deduplicate client-side or implement a clear retrieval cursor if the implementation needs one.

Return structured JSON errors with an appropriate HTTP status for invalid input, unknown/expired sessions, rate limits and server failures. `204` is a normal “not available yet” response for pending offer/answer polling, not an error.

## 6. MySQL and temporary data

A single `sessions` table is sufficient for the signaling records:

```sql
CREATE TABLE sessions (
  code VARCHAR(10) PRIMARY KEY,
  offer_sdp TEXT NULL,
  answer_sdp TEXT NULL,
  host_ice_candidates JSON NULL,
  joiner_ice_candidates JSON NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL
);
```

- Generate codes on the server. Use a clear, non-ambiguous character set and sufficient randomness; normalize and validate codes before database access.
- Use a 10–15 minute validity window for a pairing code that is waiting to be used. Handle established peer connections separately so an in-progress direct transfer is not broken simply because the original pairing window elapsed.
- An expired session must behave as nonexistent (`404`) on every relevant `GET` endpoint.
- Delete expired rows lazily when endpoints run or through a suitable cleanup process.
- Do not store filenames, file bytes, file contents, transfer history, user profiles or personal information in MySQL.
- Use prepared statements for every query. No SQL string concatenation with user-controlled values.
- Keep database credentials outside the public web root where the hosting setup permits it, and do not commit secrets to version control.

Rate-limit pairing-code validation to reduce brute-force attempts. If the rate limiter temporarily uses client IP information, retain it only for the short rate-limit window and do not turn it into user tracking or permanent profile data. Explain the implementation and its retention behavior.

## 7. Security and privacy requirements

These are requirements, not optional polish:

- Use prepared statements for every SQL query.
- Validate pairing-code format, HTTP methods, request size, JSON structure, SDP payloads, ICE candidate payloads and role values at the API boundary.
- Enforce code expiry and rate limiting.
- Do not collect accounts, passwords, names, email addresses, analytics identifiers or other personal profile data.
- Do not upload file contents or file metadata to the PHP server. Metadata used by the transfer UI travels over the peer data channel.
- Use HTTPS in deployment. Camera access and other browser capabilities may require a secure context; `localhost` is treated specially during local development, but a second device accessing the host over a LAN IP generally needs HTTPS for secure-context features.
- WebRTC data channels use DTLS encryption in transit. Describe this accurately: it protects the peer data channel, while HTTPS protects the signaling exchange. Do not claim that this makes the entire system immune to malicious signaling or compromised devices.
- Do not log SDP, ICE payloads, file names, file contents or unnecessary IP information to application logs.
- On failure or cancellation, discard partial file data and do not offer it as a valid download.
- The privacy page must accurately explain what the application server temporarily handles and what stays between devices. Do not claim “nothing ever reaches the server”; signaling metadata does.

## 8. Product experience and screen map

This is a **single-purpose flow**, not a dashboard. The primary experience should feel like one screen changing state. Use a shared header and a compact footer; do not add a large sidebar or a multi-section admin layout.

### Core screens

1. **Home / Landing**
   - Brief headline explaining direct nearby file transfer.
   - Two obvious actions: **Send a file** and **Receive a file**.
   - One concise trust statement: files move directly between devices; the server handles pairing only.
   - Link to How it works, Privacy & security, and Help.

2. **Pairing — Host**
   - Show a plain black-on-white QR code and a readable short pairing code.
   - Explain that the user should scan the code or enter it on the other device.
   - Show a waiting message with a slow pulsing coral dot.
   - Include expiry/countdown information without making it visually dominant, plus a cancel/back action.

3. **Join a device — Receiver**
   - Allow QR scanning where browser permissions and secure-context requirements support it.
   - Always provide manual code entry as a fallback; do not make camera permission mandatory.
   - Validate the code and show useful invalid, expired, or unavailable states.

4. **Connected / File selection**
   - Clearly identify the connected peer using a simple device label (for example, “This device” and “Pixel 7” only when the browser/user has supplied that label; do not invent device identity).
   - Provide a file picker and drag-and-drop area for the sender.
   - Show selected file details before the sender proceeds.

5. **Incoming-file preview / confirmation**
   - The receiver sees the incoming filename, type and size and can accept or decline.
   - Do not send file bytes until the receiver accepts.

6. **Transferring — Signature screen**
   - This is the visual centrepiece. Show one geometric device node at each end and one continuous trail linking them.
   - The trail fills from sender to receiver as bytes arrive. The filled portion uses Slip Coral; the remaining trail is neutral Mist/Steel.
   - Show the percentage near the centre of the trail, not in a separate progress bar.
   - Show filename, file size, transfer speed and estimated time remaining when those values can be calculated reliably.
   - Provide a Cancel transfer action.
   - On mobile, stack the device nodes and make the trail vertical while retaining the same visual meaning.

7. **Done**
   - Turn the trail Vector teal and show a clear checkmark/success state.
   - On the receiver, provide an explicit Download file action only after integrity verification succeeds.
   - On the sender, provide Send another and Return home actions.

8. **Error / Connection dropped**
   - Make the trail visibly break or fade in the middle; do not merely freeze the percentage.
   - Explain whether the connection was lost, the code expired, the receiver declined, the transfer was cancelled, or integrity verification failed.
   - Offer the relevant recovery action, such as Try again, Start a new session, or Return home.
   - Never label an interrupted transfer as complete.

### Supporting pages and panels

9. **Activity** — Optional, after core transfer works. Show only transfers from the current in-memory session. It is not permanent history, is not stored in MySQL, and disappears when the app session ends or the page is refreshed. Keep it lightweight.

10. **Transfer queue** — Optional stretch feature. Support multiple files sequentially, one at a time, after the single-file flow is stable. Show each file's state without introducing simultaneous data transfers. Do not implement folder upload or zipping.

11. **Help & connection diagnostics** — Include contextual errors in the core flow. A fuller help page can explain camera permission, HTTPS/secure context, expired codes, same-network expectations, browser compatibility, and what to do when a direct WebRTC connection fails. Do not promise that all network configurations will work.

12. **How it works** — A short visual/text explanation of pairing, PHP signaling, WebRTC connection establishment, and direct data transfer. Make the distinction between signaling metadata and file bytes easy to understand.

13. **Privacy & security** — Explain temporary pairing data, expiry, rate limiting, direct transfer, DTLS protection and the absence of accounts/permanent transfer history. Keep claims technically precise.

14. **Settings** — Optional and deliberately small. Use a simple modal or compact panel, not a new dashboard. Possible preferences: sound notifications (off by default) and reduced-motion behavior. Keep the light visual theme as the defined default; do not add a dark/neon theme or a large preference system.

### Navigation rule

The primary app flow remains Home → Pairing/Join → Connected → File preview → Transfer → Done/Error. Activity and Settings are secondary panels. Help, How it works, and Privacy & security are lightweight supporting pages/sections linked from the footer or a subtle menu. They must not interrupt or complicate the main transfer journey.

## 9. Visual identity — follow exactly

The design should feel fast, focused and kinetic, but restrained. The **connection trail is the one bold visual idea**. Everything else should support it quietly.

### Core visual concept

The connection between the two devices **is the progress indicator**. It is a single trail line linking the sender and receiver. As data moves, the coral-filled portion travels along the trail. The product name “Slipstream” is expressed through this trail: a visual metaphor for movement with reduced drag, not a generic upload meter.

Do not add a second standard progress bar beside or below the trail. A numeric percentage may accompany the trail, but the trail itself communicates progress.

### Color tokens

| Token | Hex | Role |
|---|---|---|
| Fog | `#F4F5F7` | Main background; cool light grey |
| Graphite | `#15171B` | Main text and strong contrast |
| Slip Coral | `#FF5A3C` | Live trail fill, primary actions, active connection cue only |
| Vector | `#2E9E83` | Connected/success state |
| Steel | `#5B6472` | Device glyphs, secondary labels and neutral UI |
| Mist | `#E7E9ED` | Panels, cards and unfilled trail |

Use coral sparingly. Do not apply it to every icon, heading, border or decorative element. Use Vector for confirmed connected/success states, not as a general accent. Keep readable contrast.

### Typography

- **Space Grotesk** for headings, device labels where appropriate, percentages, file sizes and numeric emphasis.
- **IBM Plex Sans** for body copy, controls, helper text and general UI.
- Provide sensible system fallbacks. The app must remain usable if external font loading fails.

### Shape, icons and motion

- Use simple geometric rounded-rectangle device glyphs. No skeuomorphic phone/laptop illustrations, photorealistic device renders or cartoon mascots.
- Use crisp, minimal line icons with consistent stroke weight.
- The QR code must be plain, high-contrast black modules on a white background, with a proper quiet zone. No gradients, coral modules, rounded decorative modules, logos over the code or low-contrast styling.
- Use a subtle pulse for the waiting dot and smooth, restrained trail filling during transfer. Respect `prefers-reduced-motion` and the optional reduced-motion setting.
- Avoid dark-mode-plus-neon gradients, glassmorphism, excessive shadows, noisy backgrounds, oversized decorative illustrations and generic SaaS dashboard patterns.

### Layout and responsiveness

- Design mobile-first. The complete pairing and transfer flows must work on a phone.
- Keep the primary action obvious and the transfer status readable without scrolling on common phone sizes where practical.
- Use generous whitespace, a clear content hierarchy and modest panel/card treatment.
- On wide screens, keep the main flow centred and focused; do not stretch the content across the entire viewport.

## 10. Functional and interaction requirements

### File transfer

- Core scope is one file per transfer.
- Support file picker and drag-and-drop.
- Display filename, size and type before sending.
- Transfer in ordered 16 KB chunks using `File.slice()` and `RTCDataChannel`.
- Implement data-channel back-pressure; do not blindly enqueue the entire file.
- Send transfer metadata/control messages separately from binary chunks, using a documented message format.
- Reassemble in order, verify the final digest, and only then offer download.
- Show live progress at both ends using the trail as the visual indicator.
- Estimate speed and time remaining only when there is enough reliable data; otherwise omit or show a neutral placeholder rather than inventing numbers.
- Cancel must stop sending, notify the peer when possible, discard incomplete data on both sides and show a cancelled state. If the connection is already lost, clean up locally and explain that peer notification was not possible.

### Session and connection lifecycle

- Stop all polling loops, timeouts and event listeners when leaving/cancelling a session.
- Close the `RTCDataChannel` and `RTCPeerConnection` when finished or abandoned.
- Revoke object URLs after download/cleanup.
- Avoid duplicate connection handlers, duplicate ICE candidate processing and duplicate file completion events.
- Handle connection changes before transfer, during transfer, and during integrity verification.
- Expired or invalid codes must never create a usable connection.

### Browser behavior

- Provide a manual pairing-code fallback if camera scanning is unavailable or denied.
- Show plain-language permission and compatibility guidance.
- Do not use browser/device detection to make unsupported claims about exact device identity. Device names should be user-provided or generic.

## 11. Feature priority and scope boundaries

### P0 — Core deliverable (must work)

- Responsive home/landing screen with Send and Receive actions.
- Host session creation and short-lived code + QR display.
- Join by QR and manual code.
- PHP/MySQL REST signaling and direct WebRTC connection.
- Single-file picker, drag-and-drop and sender-side file preview.
- Receiver incoming-file details with accept/decline.
- Chunked transfer, reassembly and integrity verification.
- Live sender and receiver progress using the Slipstream trail.
- Cancel transfer and explicit dropped-connection/error states.
- Successful receiver download and sender completion actions.
- Basic contextual diagnostics and concise How it works / Privacy information.
- Successful test across at least two genuinely separate physical devices on the same local network.

### P1 — Add after P0 is reliable

- Session-only Activity panel/log; never persistent.
- Sequential multi-file transfer queue, one file at a time.
- Fuller Help & connection diagnostics page.
- More polished supporting How it works and Privacy & security pages.

### P2 — Only if there is time and a real usability benefit

- Small Settings panel with sound notifications and reduced-motion preference.
- Minor quality-of-life refinements that do not alter the architecture or expand the product into a platform.

### Explicitly out of scope

- Accounts, login, profiles or user identity systems.
- Cloud upload, server-side file storage, server-side file processing or file-relay fallback.
- Permanent transfer history or database-backed activity records.
- Automatic nearby-device discovery.
- Cross-network transfer or TURN relay infrastructure.
- Folder transfer, zipping, simultaneous multi-file streaming.
- Clipboard synchronization in the initial release.
- Native mobile applications or browser extensions.
- Social features, contacts, messaging, analytics or unrelated dashboard features.

## 12. Build phases and exit criteria

### Phase 1 — Prove signaling and the peer connection

Build the PHP REST API and MySQL table. Establish an `RTCDataChannel` between two separate physical devices using the pairing code and REST polling. Send a short test text message over the data channel. The UI may be plain.

**Do not proceed until:** session creation, code validation, SDP offer/answer, ICE exchange and channel-open behavior have been tested on two separate devices on the same local network. Record any network/browser limitations.

### Phase 2 — Complete one-file transfer

Add file selection, preview, receiver acceptance, 16 KB chunking, channel back-pressure, receiver reassembly, SHA-256 integrity verification, live byte-based progress and successful download. Add the first version of the Slipstream trail.

**Do not proceed until:** a representative file transfers byte-for-byte, both devices show sensible progress, and the receiver can download only after integrity verification.

### Phase 3 — Reliability, cancellation and product experience

Add clean cancellation, dropped-connection handling, session cleanup, expiry/rate limiting, responsive pairing/transfer/done/error states, and contextual diagnostics. Complete the core visual system and supporting information pages. Test across multiple real browser/device combinations.

**Do not proceed until:** interrupted transfers never appear successful, incomplete data is discarded, cleanup works, and the P0 journey is reliable.

### Phase 4 — Optional features and finalisation

Only now consider the Activity panel and sequential multi-file queue. Add the small Settings panel only if time remains. Freeze features, fix defects, perform final cross-device tests, complete the README and prepare the demo.

Do not add new features during final QA.

## 13. Definition of done

Slipstream's core release is complete when all of the following are true:

- A user can send a file from one physical device to another physical device on the same local network using a QR code or short pairing code.
- The peer connection is established through the PHP REST signaling API and MySQL temporary session record.
- File bytes travel directly between browsers over the WebRTC data channel; they never pass through PHP/MySQL.
- The receiver accepts the incoming file, receives the complete data, passes the integrity check and can download it.
- The sender and receiver see accurate progress through the device-to-device trail.
- Cancelled, rejected, expired, interrupted and integrity-failed transfers have clear outcomes and never produce a false success state.
- Temporary session data is deleted or expires; no permanent transfer history or user account data is introduced.
- SQL uses prepared statements throughout, API inputs are validated, pairing codes are time-limited, and validation attempts are rate-limited.
- HTTPS is used for deployment and security claims in the UI/README are accurate.
- The design follows the Slipstream tokens, typography, QR requirements and restrained trail-led visual identity.
- The project has been tested on at least two genuinely separate physical devices, not merely two tabs on one computer.
- The README describes the actual implementation and clearly marks any incomplete or optional features.

## 14. Final instruction

Build **Slipstream**, not a generic file-sharing dashboard. The product's identity is the direct connection between two devices, and the connection trail is the defining visual interaction. Keep the engineering simple enough to explain, the UI focused enough to use immediately, and the privacy claims honest. Preserve the course-aligned stack and prove the hard networking problem before spending time on polish.
