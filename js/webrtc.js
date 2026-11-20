/**
 * Slipstream WebRTC Connection Manager
 * Manages RTCPeerConnection, signaling exchange, and RTCDataChannel (§4, §5, §10, §12).
 * Direct peer-to-peer data transport; zero byte routing through server.
 */

// Time between completed signaling polls on shared hosting.
const SIGNALING_POLL_MS = 2500;

class SlipstreamPeer {
  constructor({
    role,
    code,
    pollIntervalMs = SIGNALING_POLL_MS,
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
    this.pollIntervalMs = Math.max(1000, pollIntervalMs);
    this.pollTimer = null;
    this.pollController = null;
    this.isClosed = false;
    this.processedCandidates = new Set();
    this.candidateCursor = 0;
    this.receiveQueue = Promise.resolve();

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
          this.stopPolling();
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
      if (this.isClosed) return;
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
    if (this.isClosed) return;
    await this.pc.setLocalDescription(offer);
    if (this.isClosed) return;

    this.onStatusChange('Submitting offer to signaling service...');
    await Api.sendOffer(this.code, {
      sdp: offer.sdp,
      type: offer.type,
    });

    if (this.isClosed) return;
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
    this.startPolling(async signal => {
      if (!this.pc.remoteDescription) {
        const answer = await Api.getAnswer(this.code, signal);
        if (signal.aborted || !answer) return;
        await this.pc.setRemoteDescription(answer);
        if (!signal.aborted) this.onStatusChange('Received answer. Connecting directly...');
      }
      if (!signal.aborted) await this.pollCandidates('joiner', signal);
    });
  }

  startJoinerPolling() {
    let pendingAnswer;
    this.startPolling(async signal => {
      if (!this.pc.remoteDescription) {
        const offer = await Api.getOffer(this.code, signal);
        if (signal.aborted || !offer) return;
        await this.pc.setRemoteDescription(offer);
        if (signal.aborted) return;
        const answer = await this.pc.createAnswer();
        if (signal.aborted) return;
        await this.pc.setLocalDescription(answer);
        pendingAnswer = { type: answer.type, sdp: answer.sdp };
      }
      if (signal.aborted) return;
      if (pendingAnswer) {
        // Retry a transient POST failure with the same negotiated answer.
        await Api.sendAnswer(this.code, pendingAnswer, signal);
        pendingAnswer = null;
        if (!signal.aborted) this.onStatusChange('Answer submitted. Connecting...');
      }
      if (!signal.aborted) await this.pollCandidates('host', signal);
    });
  }

  startPolling(step) {
    if (this.isClosed || this.isChannelOpen() || this.pollController) return;
    this.pollController = new AbortController();
    const { signal } = this.pollController;
    let failures = 0;
    const poll = async () => {
      try {
        await step(signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures++;
        const transient = err instanceof TypeError || err.status === 408 || err.status >= 500;
        if (!transient || failures >= 5) {
          this.close();
          this.onError(err);
          return;
        }
      }
      if (!signal.aborted) {
        const delay = Math.min(30000, this.pollIntervalMs * 2 ** failures);
        this.pollTimer = setTimeout(poll, delay);
      }
    };
    this.pollTimer = setTimeout(poll, this.pollIntervalMs);
  }

  /**
   * Fetch and add new ICE candidates for the specified peer role.
   */
  async pollCandidates(peerRole, signal) {
    if (!this.pc || !this.pc.remoteDescription) return;

    const candidates = await Api.getIceCandidates(this.code, peerRole, this.candidateCursor, signal);
    for (const c of candidates) {
      if (signal.aborted) return;
      this.candidateCursor++;
      const candidateKey = JSON.stringify(c);
      if (!this.processedCandidates.has(candidateKey)) {
        this.processedCandidates.add(candidateKey);
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
      this.receiveQueue = this.receiveQueue.then(() => this.handleIncomingData(event.data))
        .catch(error => this.onError(error));
    };

    channel.onclose = () => {
      this.stopPolling();
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
  async handleIncomingData(data) {
    if (this.isClosed) return;
    if (typeof data === 'string') {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message?.protocol === 'slipstream') this.onControlMessage(message);
      else if (message?.protocol === undefined && message?.type === 'text' && typeof message.message === 'string') {
        this.onChannelMessage(data);
      }
      return;
    }
    if (data instanceof Blob) data = await data.arrayBuffer();
    if (!this.isClosed && data instanceof ArrayBuffer) this.onBinaryMessage(data);
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
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollController?.abort();
    this.pollController = null;
  }

  /**
   * Cleanly close all WebRTC and signaling resources.
   */
  close() {
    this.isClosed = true;
    this.stopPolling();
    this.receiveQueue = Promise.resolve();

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
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onicecandidate = null;
        this.pc.close();
      } catch {}
      this.pc = null;
    }

    this.processedCandidates.clear();
  }
}
