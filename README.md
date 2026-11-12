# Slipstream

**Nearby file transfer. Direct device to device. No cloud upload. No account.**

Slipstream is a browser-based file-transfer project designed to send a file directly between two nearby devices on the same local network. One device creates a temporary pairing code and QR code; the other joins using either method. The browsers establish a WebRTC peer-to-peer connection and transfer the file directly through a data channel.

The PHP/MySQL server is used only for temporary signaling. It coordinates the connection but does **not** receive or store file bytes.

> **Project status:** This README describes the intended product and architecture. Update the implementation status and setup instructions as the project is built; do not mark planned features as complete until they have been tested.

---

## Contents

- [How it works](#how-it-works)
- [Core experience](#core-experience)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Project scope](#project-scope)
- [Security and privacy](#security-and-privacy)
- [Design system](#design-system)
- [Development setup](#development-setup)
- [Testing checklist](#testing-checklist)
- [Limitations](#limitations)

## How it works

1. The sender creates a temporary Slipstream session.
2. Slipstream displays a short pairing code and a QR code containing a join link.
3. The receiver scans the QR code or enters the code manually.
4. The browsers exchange WebRTC signaling information through a PHP REST API. MySQL temporarily stores the pairing session, SDP offer/answer and ICE candidates.
5. The browsers establish a direct WebRTC `RTCDataChannel` connection.
6. The sender selects a file and previews its details. The receiver sees the incoming-file details and accepts or declines.
7. After acceptance, the sender sends the file in ordered chunks. The receiver rebuilds the file and verifies its SHA-256 digest before offering it for download.
8. The transfer ends with a clear success, cancellation or error state. Temporary signaling records are deleted or expire.

**Important:** signaling metadata passes through the application server. File metadata used by the transfer UI and the file bytes are exchanged over the peer data channel; file bytes are not uploaded to PHP/MySQL.

## Core experience

Slipstream is a single-purpose flow rather than a dashboard.

| Screen | Purpose |
|---|---|
| Home | Choose **Send a file** or **Receive a file** |
| Pairing | Host displays the QR code and short code while waiting |
| Join a device | Receiver scans the QR code or manually enters the code |
| Connected / File selection | Sender chooses a file and reviews its details |
| Incoming-file preview | Receiver accepts or declines the incoming transfer |
| Transferring | The connection trail between the two device nodes shows transfer progress |
| Done | Receiver downloads the verified file; sender can send another |
| Error | A broken/faded trail and clear message explain what went wrong |

Supporting features are deliberately secondary:

- **Activity:** optional, current-session-only transfer records; never permanent history.
- **Transfer queue:** optional sequential multi-file transfers, one file at a time.
- **Help & diagnostics:** guidance for camera permissions, HTTPS, expired codes, browser compatibility and direct-connection failures.
- **How it works:** explains the signaling and direct-transfer architecture.
- **Privacy & security:** explains temporary signaling data, direct transfer and encryption accurately.
- **Settings:** optional small panel for preferences such as sound notifications and reduced motion.

## Technology stack

| Layer | Technology |
|---|---|
| Structure | HTML5 |
| Styling | CSS3 |
| Client logic | Vanilla JavaScript |
| Direct connection | WebRTC `RTCPeerConnection` and `RTCDataChannel` |
| Signaling API | PHP REST API |
| Temporary signaling storage | MySQL |
| Database access | PDO or MySQLi prepared statements |
| File handling | Browser File API (`File`, `File.slice()`, `Blob`) |
| Integrity check | Browser SHA-256 digest, preferably via Web Crypto API |

The project deliberately avoids Node.js, frontend frameworks, WebSocket servers, cloud file storage and ORM/query-builder dependencies. REST polling is used for signaling at approximately one-second intervals while connection information is pending.

## Architecture

```text
 Sender browser                 PHP REST API + MySQL                 Receiver browser
      |                                  |                                  |
      |---- POST /sessions ------------>|                                  |
      |<--- pairing code + expiry -------|                                  |
      |                                  |<---- enter/scan pairing code -----|
      |---- POST SDP offer ------------>|<----- GET SDP offer (poll) -------|
      |<--- GET SDP answer (poll) -------|<----- POST SDP answer ------------|
      |<---- ICE candidate exchange via REST signaling ------------------->|
      |                                                                       |
      |================ direct WebRTC data channel ==========================>|
      |                                                                       |
      |---- file metadata / chunks directly to receiver ------------------->|
      |<--- receiver acceptance / control messages -------------------------|
      |                                                                       |
      |                         File bytes do not pass through PHP/MySQL      |
```

### Signaling endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/sessions` | Create a temporary pairing session |
| `GET` | `/sessions/{code}` | Validate a code and expiry |
| `POST` | `/sessions/{code}/offer` | Submit the host's SDP offer |
| `GET` | `/sessions/{code}/offer` | Poll for the offer |
| `POST` | `/sessions/{code}/answer` | Submit the joiner's SDP answer |
| `GET` | `/sessions/{code}/answer` | Poll for the answer |
| `POST` | `/sessions/{code}/ice-candidates` | Submit an ICE candidate with the sender's role |
| `GET` | `/sessions/{code}/ice-candidates?role=host\|joiner` | Retrieve candidates from the specified role |
| `DELETE` | `/sessions/{code}` | Delete temporary signaling data |

For the ICE `GET`, `role` identifies whose candidates are being retrieved. The host retrieves `role=joiner`; the joiner retrieves `role=host`.

## Project scope

### Core release

- Pairing by QR code and manual code.
- PHP/MySQL REST signaling.
- Direct WebRTC peer connection.
- One file per transfer, selected by file picker or drag-and-drop.
- Sender preview and receiver acceptance.
- Ordered 16 KB chunks, receiver reassembly and integrity verification.
- Live progress on both devices through the Slipstream trail.
- Cancel, completion and explicit connection/error states.
- Testing on two genuinely separate physical devices on the same local network.

### Optional after the core is reliable

- Session-only Activity panel.
- Sequential multi-file queue.
- Expanded Help & connection diagnostics.
- Small Settings panel.

### Out of scope

- Accounts, login or profiles.
- Cloud upload or server-side file storage/relay.
- Permanent transfer history.
- Automatic nearby-device discovery.
- Cross-network transfer or TURN relay infrastructure.
- Folder transfer, zipping or simultaneous multi-file streaming.
- Clipboard synchronization in the initial release.
- Native mobile apps or browser extensions.

## Security and privacy

- Use prepared statements for every SQL query.
- Validate pairing codes, request bodies, SDP, ICE candidates and role values.
- Pairing codes should expire after approximately 10–15 minutes while waiting to be used.
- Rate-limit code validation to reduce guessing attacks.
- Delete expired signaling records. Do not retain permanent file or activity history.
- Do not send file bytes, filenames or transfer metadata to the PHP server. Transfer metadata used by the UI travels directly between the browsers.
- Use HTTPS in deployment. Browser camera access and related APIs require a secure context; a second device accessing a development server by LAN IP may need HTTPS.
- WebRTC data channels use DTLS encryption in transit. HTTPS protects the signaling exchange. These protections do not make compromised devices or malicious signaling infrastructure impossible.
- Do not claim that no data ever reaches the server: pairing and signaling metadata does.

## Design system

The visual identity is built around one idea: **the connection between the devices is the progress indicator.** The trail fills from sender to receiver as file chunks arrive. It becomes teal on success and visibly breaks/fades when the connection is lost.

### Colors

| Token | Hex | Use |
|---|---|---|
| Fog | `#F4F5F7` | Main background |
| Graphite | `#15171B` | Primary text |
| Slip Coral | `#FF5A3C` | Active trail, primary actions and active connection cue |
| Vector | `#2E9E83` | Connected/success state |
| Steel | `#5B6472` | Device glyphs and secondary UI |
| Mist | `#E7E9ED` | Panels and unfilled trail |

### Typography and visual rules

- Space Grotesk for headings and numeric emphasis.
- IBM Plex Sans for body text and controls.
- Simple geometric rounded-rectangle device glyphs; no skeuomorphic device illustrations.
- QR codes remain plain black-on-white, square-module and high contrast, with a proper quiet zone.
- No neon gradients, dark-mode tech clichés, glassmorphism or decorative clutter.
- Use restrained motion and respect `prefers-reduced-motion`.
- Mobile layouts must preserve the device-to-device trail, stacking the endpoints and turning the trail vertical where needed.

## Development setup

The exact commands and file paths depend on the repository implementation. Keep this section aligned with the actual project files once they exist.

### Requirements

- A PHP environment with the PDO/MySQL extension (or MySQLi if that is the chosen implementation).
- MySQL or a compatible MariaDB installation.
- A modern browser with WebRTC, File API and Web Crypto support.
- Two physical devices connected to the same local network for meaningful end-to-end testing.
- HTTPS for deployed use and for secure-context browser features such as camera access.

### Setup checklist

1. Clone or download the project repository.
2. Create the MySQL database.
3. Run the project's schema SQL to create the `sessions` table.
4. Configure database credentials in a server-side configuration file kept outside the public web root where possible. Never commit real credentials.
5. Configure the web server so the public frontend can call the PHP API under the documented `/sessions` endpoints.
6. Serve the site over HTTPS when testing camera scanning or accessing it from another device. `localhost` has special secure-context treatment, but a LAN IP address generally does not.
7. Open Slipstream on the sender and receiver devices, connect them to the same local network, and test the full pairing and transfer flow.

### Project Directory Structure

```text
slipstream/
├── .gitignore                      # Git ignored files (credentials, backups, local env)
├── .htaccess                       # Apache rewrite rules for /sessions and front-controller
├── router.php                      # Built-in PHP server router (php -S 0.0.0.0:8000 router.php)
├── index.html                      # Semantic single-page HTML5 application
├── README.md                       # Product documentation and setup guide
├── SLIPSTREAM_ASSISTANT_PROMPT.md  # Master build prompt & engineering specification
├── config/
│   ├── .htaccess                   # Blocks direct web access to configuration
│   ├── config.php                  # Database configuration loader (env / config.local.php)
│   └── config.example.php          # Template for local MySQL credentials
├── database/
│   └── schema.sql                  # MySQL schema for sessions & rate_limits tables
├── api/
│   ├── db.php                      # PDO connection factory, prepared statements, lazy cleanup
│   └── sessions.php                # REST signaling endpoints (/sessions)
├── css/
│   └── style.css                   # Slipstream design system, tokens, device nodes & trail
└── js/
    ├── api.js                      # Fetch API signaling client
    ├── webrtc.js                   # WebRTC RTCPeerConnection and RTCDataChannel manager
    ├── app.js                      # UI state machine and Phase 1 data channel verification
    └── vendor/
        └── qrcode.min.js           # Client-side offline QR generator (no external calls)
```

### Quickstart Setup

1. **Import the database schema:**
   ```bash
   mysql -u root -p < database/schema.sql
   ```
   *(On AMPPS on Windows, the default MySQL user is `root` and default password is `mysql`)*.

2. **Configure database credentials:**
   Copy `config/config.example.php` to `config/config.local.php` if your local MySQL settings differ from default:
   ```bash
   cp config/config.example.php config/config.local.php
   ```

3. **Start the local development server:**
   Using PHP's built-in web server:
   ```bash
   php -S 0.0.0.0:8000 router.php
   ```
   Or place this directory inside your web server document root (e.g., AMPPS `www` or XAMPP `htdocs`).

4. **Test Phase 1 Signaling & Direct Peer Connection:**
   - Open `http://localhost:8000` on Device 1 (or host machine).
   - Click **Send a file**. A pairing code and QR code are generated.
   - On Device 2 (or second browser window on same network), open `http://<HOST-IP>:8000` and click **Receive a file**.
   - Enter the 6-character pairing code or scan the QR code.
   - Once connected, send a test message through the Phase 1 test box to confirm direct WebRTC peer transmission with zero server routing.

## Testing checklist

- [x] Create a session and receive a valid short code and expiry.
- [x] QR code contains the correct join URL and is generated purely client-side.
- [x] Manual code entry works when camera access is unavailable.
- [x] Invalid and expired codes are rejected with structured JSON errors.
- [x] Offer, answer and ICE candidates are exchanged through the REST API.
- [ ] Direct data channel open verified between two separate physical devices on LAN.
- [ ] Receiver can accept or decline an incoming file (Phase 2).
- [ ] Small and larger test files transfer successfully (Phase 2).
- [ ] Received file matches the original after integrity verification (Phase 2).
- [ ] Sender and receiver progress reflect actual bytes transferred (Phase 2).
- [ ] Cancel stops the transfer and clears incomplete data (Phase 3).
- [ ] A dropped connection produces an explicit error state, never false success (Phase 3).
- [x] Expired and completed signaling records are cleaned up lazily.
- [x] SQL uses prepared statements and pairing-code validation is rate-limited.
- [x] Layout and primary actions work on desktop and mobile widths.
- [ ] QR scanning, permissions and secure-context guidance tested on a phone.

## Limitations

- The initial target is devices on the same local network. Direct WebRTC connectivity can still be affected by browser, firewall and network configuration.
- There is no TURN relay or server-side file-transfer fallback.
- Pairing uses an explicit QR code or short code; there is no automatic nearby-device discovery.
- The server temporarily handles signaling metadata, but it does not handle file bytes.
- Optional Activity, multi-file queue and Settings features should not delay the reliable single-file transfer experience.

---

**Slipstream's guiding principle:** keep the connection direct, the interface focused, and the trail unmistakable.
