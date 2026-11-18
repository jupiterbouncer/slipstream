# Slipstream — Live Demo & Presentation Walkthrough Script

**Document ID:** `QA-DEMO-001`  
**Purpose:** Step-by-step presentation script and live demonstration checklist for class presentations, project evaluation, and grading defense.  
**Demonstration Length:** 5–7 minutes  
**Required Equipment:**
1. **Host Device (Laptop):** Displaying Slipstream on projector/screen (`http://192.168.x.x:8000`).
2. **Joiner Device (Mobile Phone):** On the same local Wi-Fi.
3. **Local Signaling Server:** Running PHP CLI (`php -S 0.0.0.0:8000 router.php`) + MySQL.

---

## 1. Pre-Demo Setup Checklist (2 Minutes Prior)

- [ ] Verify both laptop and mobile device are connected to the same Wi-Fi network.
- [ ] Confirm PHP signaling server is active:
  ```bash
  php -S 0.0.0.0:8000 router.php
  ```
- [ ] Ensure MySQL database is migrated (`database/schema.sql`).
- [ ] Open [`qa/test-generator.html`](file:///c:/Users/Demilade%20Subair/OneDrive%20-%20Ashesi%20University/3rd%20year/1st%20Semester/Web%20Tech/Final%20Project/slipstream/qa/test-generator.html) in a background tab for quick test fixture generation and hash verification.
- [ ] Open Slipstream on the laptop: `http://localhost:8000` (or local LAN IP).

---

## 2. Live Demo Script (Step-by-Step)

### Act 1: The Pairing Flow & Zero-Storage Architecture (1.5 Minutes)

#### Visual Action:
1. On the laptop, click **"Send a file"**.
2. Show the pairing screen displaying the **6-character pairing code** and the **high-contrast QR code** with the subtle scanning line.
3. On the mobile phone, open the camera or navigate to the join URL via QR code (or type the code manually in **"Receive a file"**).

#### Speaking Points:
> "Slipstream is engineered for direct, peer-to-peer local file transfer. Notice what just happened:
>
> 1. Our laptop generated an ephemeral 6-digit code.
> 2. The PHP backend acts solely as a lightweight signaling plane—exchanging SDP offers, answers, and ICE candidate network descriptors.
> 3. Once connected, direct WebRTC data channels take over. Your file bytes **never touch our PHP server or MySQL database**. No cloud, no third-party tracking, no storage footprint."

---

### Act 2: Connected State & File Selection (1 Minute)

#### Visual Action:
1. The moment the data channel opens, highlight the header transitioning to green **"Connected"** and the geometric device glyphs gently lifting and settling.
2. Select a test file (e.g., `test_16385b.bin` from `qa/fixtures/` or an image/document).
3. Point out the file preview showing name and formatted size.

#### Speaking Points:
> "The connection is established directly browser-to-browser with DTLS encryption. Before sending, our system enforces a 100 MB whole-file guardrail to ensure memory safety.
>
> We will transfer `test_16385b.bin`—this is exactly 16 KiB plus 1 byte, meaning it tests chunk boundary transitions across two distinct 16 KB chunks."

---

### Act 3: Streaming, Back-Pressure & The Coral Trail (2 Minutes)

#### Visual Action:
1. Laptop clicks **"Send file"**.
2. On the mobile phone, show the **"Incoming file"** preview card displaying the exact filename and size. Point out: *"Nothing is downloaded until the receiver accepts."*
3. Mobile clicks **"Accept transfer"**.
4. Both screens enter the transferring view:
   - Point out the **Slipstream Coral mascot marker** traveling across the connection trail.
   - Point out the moving highlight streak and live transfer speed (MB/s) and ETA.
   - Note that the progress represents confirmed bytes received on the mobile phone, not just sender buffer enqueue.

#### Speaking Points:
> "Notice the handshake: the sender computes the SHA-256 digest upfront and sends metadata in a `file-offer`. The receiver explicitly approves.
>
> Once accepted, the sender slices the file into ordered 16 KiB binary chunks using `File.slice()`. We implemented WebRTC back-pressure flow control: if the internal network buffer exceeds 1 MB, the sender pauses until the buffer drops below 256 KB. This ensures neither browser tabs crash, even on low-powered mobile phones."

---

### Act 4: Cryptographic Verification & Completion (1.5 Minutes)

#### Visual Action:
1. As the transfer completes:
   - The connection trail seamlessly transitions from Slip Coral to **Vector teal**.
   - The animated checkmark draws itself into view.
   - On the mobile phone, the **"Download file"** button appears.
2. Click Download on the phone.
3. (Optional verification): Load the downloaded file into `qa/test-generator.html` Verifier tab; show the green **"SHA-256 MATCH"** badge confirming 100% byte-for-byte fidelity.

#### Speaking Points:
> "Upon receiving the final chunk, the receiver reassembles the binary Blob and calculates the SHA-256 hash using the Web Crypto API.
>
> Only when the computed digest matches both the initial offer and completion digest does the receiver emit `file-complete-ack` and unlock the verified download button. If a single byte had been corrupted or dropped, the transfer would immediately fail with `HASH_MISMATCH` and discard partial data. This guarantees true cryptographic integrity."

---

## 3. Q&A Defense & Architectural Talking Points

### Question 1: "Why 16 KiB chunks instead of larger 64 KiB chunks?"
> **Answer:** "16 KiB (16,384 bytes) is the cross-browser safe packet size for WebRTC `RTCDataChannel`. While some desktop browsers support larger SCTP packets, older mobile WebKit engines drop or fragment chunks exceeding 16 KiB. Sticking strictly to 16 KiB guarantees 100% reliability across all mobile devices."

### Question 2: "How do you prevent memory exhaustion on large files?"
> **Answer:** "Two mechanisms: First, an implementation guardrail of 100 MiB for in-memory hashing. Second, data-channel back-pressure using `bufferedAmount` and `bufferedAmountLowThreshold`: the sender monitors its queued bytes and pauses if the buffer exceeds 1 MiB, resuming only when the buffer clears to 256 KiB."

### Question 3: "What happens if a device drops Wi-Fi mid-transfer?"
> **Answer:** "The WebRTC `onconnectionstatechange` or `onclose` event fires immediately. Both peers transition the trail into the broken error state, alert the user with 'Transfer interrupted', and purge all partial memory buffers. No incomplete or corrupted files are ever saved."
