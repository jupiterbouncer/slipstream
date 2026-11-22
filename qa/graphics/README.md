# Slipstream Graphics & Visual Assets

This directory contains vector graphics (SVGs), presentation visuals, and architecture diagrams created for the **Slipstream** WebRTC file transfer system as part of the Phase 2 QA and presentation deliverables.

---

## 1. Vector Graphics Catalog

| Graphic File | Format | Description | Target Use Case |
|---|---|---|---|
| [`system_architecture.svg`](file:///c:/Users/Demilade%20Subair/OneDrive%20-%20Ashesi%20University/3rd%20year/1st%20Semester/Web%20Tech/Final%20Project/slipstream/qa/graphics/system_architecture.svg) | SVG (1000x680) | Comprehensive system architecture showing Browser A (Host / Sender), Ephemeral PHP/MySQL Signaling Plane, Browser B (Joiner / Receiver), and the direct DTLS-encrypted WebRTC DataChannel. | Architecture documentation, final report, and project presentation slide decks. |
| [`protocol_sequence.svg`](file:///c:/Users/Demilade%20Subair/OneDrive%20-%20Ashesi%20University/3rd%20year/1st%20Semester/Web%20Tech/Final%20Project/slipstream/qa/graphics/protocol_sequence.svg) | SVG (960x720) | Step-by-step sequence diagram of the Phase 2 file transfer protocol (`file-offer` &rarr; `file-accept` &rarr; `file-start` &rarr; binary chunks &rarr; `file-progress` &rarr; `file-complete` &rarr; SHA-256 verification &rarr; `file-complete-ack`). | Protocol design documentation, technical defense, and code walkthroughs. |
| [`chunking_backpressure.svg`](file:///c:/Users/Demilade%20Subair/OneDrive%20-%20Ashesi%20University/3rd%20year/1st%20Semester/Web%20Tech/Final%20Project/slipstream/qa/graphics/chunking_backpressure.svg) | SVG (960x520) | Visualization of 16 KiB chunk slicing via `File.slice()` and the back-pressure flow control mechanism (1 MiB high-water mark pause, 256 KiB low threshold resume). | WebRTC engineering analysis and memory safety demonstration. |

---

## 2. Mermaid Source Diagrams

For markdown renderers and presentation decks that support inline Mermaid:

### Architecture Flowchart
```mermaid
flowchart TD
    subgraph Signaling ["Ephemeral Signaling Plane (PHP 8.2 / MySQL)"]
        API["REST API (/api/sessions)"]
        DB[("MySQL: sessions & rate_limits")]
        API <--> DB
    end

    subgraph Host ["Host Device (Sender)"]
        H_UI["Slipstream UI (Alex's Laptop)"]
        H_SENDER["SlipstreamFileSender (Chunking & Hashing)"]
        H_RTC["SlipstreamPeer (WebRTC Transport)"]
        H_UI --> H_SENDER --> H_RTC
    end

    subgraph Joiner ["Joiner Device (Receiver)"]
        J_UI["Slipstream UI (Mobile Phone)"]
        J_RCV["SlipstreamFileReceiver (Reassembly & Verify)"]
        J_RTC["SlipstreamPeer (WebRTC Transport)"]
        J_RTC --> J_RCV --> J_UI
    end

    %% Signaling flows
    H_RTC -.->|"1. Create Session & SDP Offer"| API
    J_RTC -.->|"2. Join via Code / QR & SDP Answer"| API
    H_RTC <-.->|"3. ICE Candidate Polling"| API
    J_RTC <-.->|"3. ICE Candidate Polling"| API

    %% Direct P2P Channel
    H_RTC ===|"Direct RTCDataChannel ('slipstream-transfer')\nDTLS Encrypted • 16 KiB Chunks • Zero Server Storage"| J_RTC
```

### Protocol Sequence Diagram
```mermaid
sequenceDiagram
    autonumber
    actor Sender as Host (Sender)
    actor Receiver as Joiner (Receiver)

    Note over Sender: User selects file.<br/>Calculates SHA-256 digest.
    Sender->>Receiver: file-offer (name, size, mimeType, SHA-256)
    Note over Receiver: Validates metadata.<br/>Renders preview card.
    Receiver->>Receiver: User clicks "Accept transfer"
    Receiver->>Sender: file-accept (transferId)
    Sender->>Receiver: file-start (transferId)

    loop Ordered 16 KiB Streaming
        Sender->>Receiver: Binary Chunk [ArrayBuffer (16384 B)]
        Receiver->>Sender: file-progress (bytesReceived, totalBytes)
    end

    Sender->>Receiver: file-complete (bytesSent, chunksSent, SHA-256)
    Note over Receiver: Reassembles chunks into Blob.<br/>Computes whole-file SHA-256.<br/>Verifies hash matches offer & complete.
    Receiver->>Sender: file-complete-ack (status: "verified")
    Note over Sender: Transitions trail to Vector teal.
    Note over Receiver: Transitions trail to Vector teal.<br/>Unlocks verified Download button.
```
