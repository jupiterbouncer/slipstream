/**
 * Slipstream WebRTC Connection Manager
 * Manages RTCPeerConnection, signaling exchange, and RTCDataChannel (§4, §5, §10, §12).
 * Direct peer-to-peer data transport; zero byte routing through server.
 */

// Time between completed signaling polls on shared hosting.
const SIGNALING_POLL_MS = 2500;

class SlipstreamPeer {
  static diagnostics = [];

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
    this.pendingCandidates = [];
    this.disconnectTimer = null;
    this.candidateCursor = 0;
    this.receiveQueue = Promise.resolve();
    SlipstreamPeer.diagnostics = [];

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

      this.pc.onicecandidate = ({ candidate }) => {
        if (candidate && !this.isClosed && !this.isChannelOpen()) {
          this.pendingCandidates.push(candidate.toJSON());
        }
      };
      this.pc.onicecandidateerror = event => this.log('ICE gathering error', { code: event.errorCode });
      this.pc.onicegatheringstatechange = () => this.log('ICE gathering', { state: this.pc.iceGatheringState });
      this.pc.onsignalingstatechange = () => this.log('signaling', { state: this.pc.signalingState });
      this.pc.oniceconnectionstatechange = () => {
        this.log('ICE connection', { state: this.pc.iceConnectionState });
        this.logCandidatePairs();
        if (this.pc.iceConnectionState === 'failed') this.connectionFailed();
      };
      this.pc.onconnectionstatechange = () => {
        const state = this.pc.connectionState;
        this.log('peer connection', { state });
        if (state === 'failed') return this.connectionFailed();
        if (state === 'disconnected') {
          this.disconnectTimer ??= setTimeout(() => this.connectionFailed(), 10000);
          return;
        }
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        if (!this.isChannelOpen() && (state === 'connecting' || state === 'connected')) {
          this.onStatusChange('Establishing secure connection…');
        }
      };

      if (this.role === 'host') {
        await this.initHost();
      } else {
        await this.initJoiner();
      }
    } catch (err) {
      if (this.isClosed) return;
      this.connectionFailed(err);
    }
  }

  /**
   * Host initializes data channel and creates SDP offer.
   */
  async initHost() {
    this.onStatusChange('Preparing connection…');
    this.dataChannel = this.pc.createDataChannel('slipstream-transfer', {
      ordered: true,
    });
    this.setupDataChannel(this.dataChannel);

    const offer = await this.pc.createOffer();
    if (this.isClosed) return;
    await this.pc.setLocalDescription(offer);
    if (this.isClosed) return;

    await Api.sendOffer(this.code, {
      sdp: offer.sdp,
      type: offer.type,
    });

    if (this.isClosed) return;
    this.onStatusChange('Waiting for the other device…');
    this.startHostPolling();
  }

  /**
   * Joiner waits for offer, applies it, and creates SDP answer.
   */
  async initJoiner() {
    this.onStatusChange('Waiting for connection details…');

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
        this.onStatusChange('Exchanging connection details…');
        await this.pc.setRemoteDescription(answer);
        if (!signal.aborted) this.onStatusChange('Establishing secure connection…');
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
        this.onStatusChange('Exchanging connection details…');
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
        if (!signal.aborted) this.onStatusChange('Establishing secure connection…');
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
        // Remove only acknowledged candidates. A transient POST failure retries
        // through the same bounded poll scheduler. Receivers deduplicate replays.
        while (this.pendingCandidates.length && !signal.aborted) {
          await Api.sendIceCandidate(this.code, this.role, this.pendingCandidates[0], signal);
          if (signal.aborted) return;
          this.pendingCandidates.shift();
          this.log('local ICE candidate acknowledged');
        }
        if (signal.aborted) return;
        await step(signal);
        if (!signal.aborted) this.logCandidatePairs();
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures++;
        const transient = err instanceof TypeError || err.name === 'InvalidStateError' || err.status === 408 || err.status >= 500;
        if (!transient || failures >= 5) {
          this.connectionFailed(err);
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
      const candidateKey = JSON.stringify(c);
      if (!this.processedCandidates.has(candidateKey)) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(c));
          this.log('remote ICE candidate accepted', { index: this.candidateCursor });
        } catch (candidateErr) {
          if (signal.aborted) return;
          this.log('remote ICE candidate rejected', { reason: candidateErr.name, index: this.candidateCursor });
          if (candidateErr.name === 'InvalidStateError') throw candidateErr;
        }
        this.processedCandidates.add(candidateKey);
      }
      this.candidateCursor++;
    }
  }

  /**
   * Setup data channel listeners.
   */
  setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.logCandidatePairs();
      this.onStatusChange('Connected');
      this.stopPolling();
      this.onChannelOpen(channel);
    };

    channel.onmessage = (event) => {
      this.receiveQueue = this.receiveQueue.then(() => this.handleIncomingData(event.data))
        .catch(error => this.onError(error));
    };

    channel.onclose = () => {
      this.stopPolling();
      this.log('data channel closed');
      this.onChannelClose();
    };

    channel.onerror = (err) => {
      this.connectionFailed(err.error);
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

  log(event, details = {}) {
    console.debug('[Slipstream WebRTC]', this.role, event, details);
    SlipstreamPeer.diagnostics.push({ time: new Date().toISOString(), role: this.role, event, ...details });
    // Bound memory and retain the last attempt after its peer is closed.
    if (SlipstreamPeer.diagnostics.length > 200) SlipstreamPeer.diagnostics.shift();
  }

  logCandidatePairs() {
    const pc = this.pc;
    if (!pc?.getStats || this.statsPending) return;
    this.statsPending = true;
    pc.getStats().then(report => {
      if (this.pc !== pc) return;
      const pairs = [];
      const candidates = [];
      report.forEach(row => {
        if (row.type === 'local-candidate' || row.type === 'remote-candidate') {
          candidates.push({ side: row.type, type: row.candidateType, protocol: row.protocol });
        }
        if (row.type === 'candidate-pair') pairs.push({
          state: row.state, nominated: !!row.nominated,
          local: report.get(row.localCandidateId)?.candidateType,
          remote: report.get(row.remoteCandidateId)?.candidateType,
          requestsSent: row.requestsSent, responsesReceived: row.responsesReceived,
          requestsReceived: row.requestsReceived, responsesSent: row.responsesSent,
        });
      });
      this.log('ICE candidate pairs', { candidates, pairs });
    }).catch(() => {
      if (this.pc === pc) this.log('ICE statistics unavailable');
    }).finally(() => { this.statsPending = false; });
  }

  connectionFailed(error) {
    if (this.isClosed) return;
    this.logCandidatePairs();
    this.log('connection failed', {
      error: error?.name, status: error?.status, ice: this.pc?.iceConnectionState,
      signaling: this.pc?.signalingState, remoteCandidatesRead: this.candidateCursor,
      localCandidatesPending: this.pendingCandidates.length,
    });
    this.onStatusChange("Couldn't connect to device");
    this.close();
    this.onError(error || new Error("Couldn't connect to device"));
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
    clearTimeout(this.disconnectTimer);
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
        this.pc.ondatachannel = null;
        this.pc.onicecandidateerror = null;
        this.pc.onicegatheringstatechange = null;
        this.pc.onsignalingstatechange = null;
        this.pc.close();
      } catch {}
      this.pc = null;
    }

    this.pendingCandidates.length = 0;
    this.processedCandidates.clear();
  }
}
