/**
 * Slipstream WebRTC Connection Manager
 * Manages RTCPeerConnection, signaling exchange, and RTCDataChannel (§4, §5, §10, §12).
 * Direct peer-to-peer data transport; zero byte routing through server.
 */

class SlipstreamPeer {
  constructor({
    role,
    code,
    onStatusChange,
    onChannelOpen,
    onChannelMessage,
    onControlMessage,
    onBinaryMessage,
    onChannelClose,
    onError,
  }) {
    this.role = role; // 'host' | 'joiner'
    this.code = code;
    this.onStatusChange = onStatusChange || (() => {});
    this.onChannelOpen = onChannelOpen || (() => {});
    this.onChannelMessage = onChannelMessage || (() => {});
    this.onControlMessage = onControlMessage || (() => {});
    this.onBinaryMessage = onBinaryMessage || (() => {});
    this.onChannelClose = onChannelClose || (() => {});
    this.onError = onError || (() => {});

    this.pc = null;
    this.dataChannel = null;
    this.pollingInterval = null;
    this.isClosed = false;
    this.processedCandidates = new Set();
    this.candidateCursor = 0;
    this.blobQueue = Promise.resolve();

    // Standard STUN configuration for local candidate discovery
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };
  }

  /**
   * Start the connection process based on role.
   */
  async start() {
    try {
      this.pc = new RTCPeerConnection(this.rtcConfig);

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          Api.sendIceCandidate(this.code, this.role, event.candidate.toJSON()).catch((err) => {
            console.warn('Failed to send ICE candidate:', err);
          });
        }
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc ? this.pc.connectionState : 'closed';
        this.onStatusChange(`Connection: ${state}`);
        if (state === 'connected') {
          this.stopPolling();
        } else if (state === 'failed' || state === 'disconnected') {
          this.onError(new Error(`WebRTC peer connection state is ${state}`));
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc ? this.pc.iceConnectionState : 'closed';
        if (state === 'connected' || state === 'completed') {
          this.stopPolling();
        }
      };

      if (this.role === 'host') {
        await this.initHost();
      } else {
        await this.initJoiner();
      }
    } catch (err) {
      this.onError(err);
      this.close();
    }
  }

  /**
   * Host initializes data channel and creates SDP offer.
   */
  async initHost() {
    this.onStatusChange('Creating direct data channel...');
    this.dataChannel = this.pc.createDataChannel('slipstream-transfer', {
      ordered: true,
    });
    this.setupDataChannel(this.dataChannel);

    this.onStatusChange('Creating connection offer...');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.onStatusChange('Submitting offer to signaling service...');
    await Api.sendOffer(this.code, {
      sdp: offer.sdp,
      type: offer.type,
    });

    this.onStatusChange('Waiting for peer to join...');
    this.startHostPolling();
  }

  /**
   * Joiner waits for offer, applies it, and creates SDP answer.
   */
  async initJoiner() {
    this.onStatusChange('Waiting for connection offer from host...');

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel(this.dataChannel);
    };

    this.startJoinerPolling();
  }

  /**
   * Host polling loop: waits for answer and fetches joiner's ICE candidates.
   */
  startHostPolling() {
    let hasAnswer = false;

    this.pollingInterval = setInterval(async () => {
      if (this.isClosed) return;

      try {
        // 1. Poll for answer if not yet received
        if (!hasAnswer) {
          const answer = await Api.getAnswer(this.code);
          if (answer && answer.sdp) {
            await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
            hasAnswer = true;
            this.onStatusChange('Received answer. Connecting directly...');
          }
        }

        // 2. Poll for joiner ICE candidates (role=joiner as per §5 contract)
        if (hasAnswer) {
          await this.pollCandidates('joiner');
        }
      } catch (err) {
        console.warn('Host signaling poll error:', err);
      }
    }, 1000);
  }

  /**
   * Joiner polling loop: waits for offer, then fetches host's ICE candidates.
   */
  startJoinerPolling() {
    let hasSetOffer = false;

    this.pollingInterval = setInterval(async () => {
      if (this.isClosed) return;

      try {
        // 1. Poll for offer
        if (!hasSetOffer) {
          const offer = await Api.getOffer(this.code);
          if (offer && offer.sdp) {
            hasSetOffer = true;
            this.onStatusChange('Offer received. Generating answer...');

            await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            await Api.sendAnswer(this.code, {
              sdp: answer.sdp,
              type: answer.type,
            });

            this.onStatusChange('Answer submitted. Connecting...');
          }
        }

        // 2. Poll for host ICE candidates (role=host as per §5 contract)
        if (hasSetOffer) {
          await this.pollCandidates('host');
        }
      } catch (err) {
        console.warn('Joiner signaling poll error:', err);
      }
    }, 1000);
  }

  /**
   * Fetch and add new ICE candidates for the specified peer role.
   */
  async pollCandidates(peerRole) {
    if (!this.pc || !this.pc.remoteDescription) return;

    const candidates = await Api.getIceCandidates(this.code, peerRole, this.candidateCursor);
    for (const c of candidates) {
      const candidateKey = JSON.stringify(c);
      if (!this.processedCandidates.has(candidateKey)) {
        this.processedCandidates.add(candidateKey);
        this.candidateCursor++;
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(c));
        } catch (candidateErr) {
          console.warn('Could not add ICE candidate:', candidateErr);
        }
      }
    }
  }

  /**
   * Setup data channel listeners.
   */
  setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.onStatusChange('Data channel open. Direct peer connection active.');
      this.stopPolling();
      this.onChannelOpen(channel);
    };

    channel.onmessage = (event) => {
      this.handleIncomingData(event.data);
    };

    channel.onclose = () => {
      this.onStatusChange('Data channel closed.');
      this.onChannelClose();
    };

    channel.onerror = (err) => {
      console.error('Data channel error:', err);
      this.onError(err);
    };
  }

  /**
   * Distinguish incoming string control messages from binary chunks and route them (§2.1, §7.1).
   */
  handleIncomingData(data) {
    if (this.isClosed) return;

    // 1. Text control message
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        // Verify common Phase 2 control message envelope (§2.2)
        if (
          parsed &&
          typeof parsed === 'object' &&
          parsed.protocol === 'slipstream' &&
          parsed.version === 1 &&
          typeof parsed.type === 'string' &&
          typeof parsed.transferId === 'string'
        ) {
          this.onControlMessage(parsed);
          return;
        }

        // Legacy Phase 1 test-chat message fallback ({ type: "text", message: "..." })
        this.onChannelMessage(data);
      } catch {
        // Plain non-JSON string fallback
        this.onChannelMessage(data);
      }
      return;
    }

    // 2. Binary message (ArrayBuffer)
    if (data instanceof ArrayBuffer) {
      this.onBinaryMessage(data);
      return;
    }

    // 3. Binary message delivered as Blob (browser fallback)
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      // Serialize conversions through a promise queue to preserve arrival order (§7.1)
      this.blobQueue = this.blobQueue
        .then(() => data.arrayBuffer())
        .then((buffer) => {
          if (!this.isClosed) {
            this.onBinaryMessage(buffer);
          }
        })
        .catch((err) => {
          console.error('Blob to ArrayBuffer conversion failed:', err);
          this.onError(err);
        });
      return;
    }

    // 4. TypedArray / ArrayBufferView
    if (ArrayBuffer.isView(data)) {
      this.onBinaryMessage(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      return;
    }

    console.warn('Unhandled data type received on RTCDataChannel:', typeof data);
  }

  /**
   * Send a Phase 2 control message with envelope validation (§2.2, §7.1).
   * @param {Object} message - Control message object with protocol envelope.
   */
  sendControl(message) {
    if (!this.isChannelOpen()) {
      throw new Error('Data channel is not open for control transmission');
    }
    if (!message || typeof message !== 'object') {
      throw new Error('Control message must be a valid object');
    }
    if (
      message.protocol !== 'slipstream' ||
      message.version !== 1 ||
      typeof message.type !== 'string' ||
      typeof message.transferId !== 'string'
    ) {
      throw new Error('Invalid Phase 2 control message envelope (requires protocol="slipstream", version=1, type, and transferId)');
    }
    this.dataChannel.send(JSON.stringify(message));
  }

  /**
   * Send a raw binary chunk (ArrayBuffer) through the data channel (§2.1, §3.2, §7.1).
   * @param {ArrayBuffer|ArrayBufferView} buffer - Raw chunk bytes.
   */
  sendBinary(buffer) {
    if (!this.isChannelOpen()) {
      throw new Error('Data channel is not open for binary transmission');
    }
    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
      throw new Error('Binary payload must be an ArrayBuffer or ArrayBufferView');
    }
    this.dataChannel.send(buffer);
  }

  /**
   * Send raw data (preserved for Phase 1 text-chat compatibility).
   * @param {string|ArrayBuffer} data
   */
  send(data) {
    if (!this.isChannelOpen()) {
      throw new Error('Data channel is not open');
    }
    this.dataChannel.send(data);
  }

  /**
   * Check whether data channel is open and ready.
   * @returns {boolean}
   */
  isChannelOpen() {
    return !!(this.dataChannel && this.dataChannel.readyState === 'open');
  }

  /**
   * Current queued buffer size in bytes (for back-pressure monitoring, §6).
   */
  get bufferedAmount() {
    return this.dataChannel ? this.dataChannel.bufferedAmount : 0;
  }

  /**
   * Set low threshold in bytes for bufferedamountlow event (§6).
   */
  set bufferedAmountLowThreshold(value) {
    if (this.dataChannel) {
      this.dataChannel.bufferedAmountLowThreshold = value;
    }
  }

  get bufferedAmountLowThreshold() {
    return this.dataChannel ? this.dataChannel.bufferedAmountLowThreshold : 0;
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Cleanly close all WebRTC and signaling resources.
   */
  close() {
    this.isClosed = true;
    this.stopPolling();
    this.blobQueue = Promise.resolve();

    if (this.dataChannel) {
      try {
        this.dataChannel.onopen = null;
        this.dataChannel.onmessage = null;
        this.dataChannel.onclose = null;
        this.dataChannel.onerror = null;
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }

    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }

    this.processedCandidates.clear();
  }
}
