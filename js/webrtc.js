/**
 * Slipstream WebRTC Connection Manager
 * Manages RTCPeerConnection, signaling exchange, and RTCDataChannel (§4, §5, §10, §12).
 * Encrypted WebRTC data transport with optional TURN relay discovery.
 */

// Time between completed signaling polls on shared hosting.
const SIGNALING_POLL_MS = 2500;
// Allow one consent-expiry interval for a path to recover. Native failures end it sooner.
const DISCONNECT_RECOVERY_MS = 30000;
const POST_OPEN_TRICKLE_MS = 4 * SIGNALING_POLL_MS;

function transientSignalingError(error) {
  return error instanceof TypeError || error.name === 'InvalidStateError' || error.status === 408 || error.status >= 500;
}

function addressFamily(address) {
  if (!address) return undefined;
  if (/\.local\.?$/i.test(address)) return 'mDNS';
  if (address.includes(':')) return 'IPv6';
  if (/^\d+(\.\d+){3}$/.test(address)) return 'IPv4';
}

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
    onApplicationMessage,
    onBinaryMessage,
    onChannelClose,
    onError,
  }) {
    this.role = role; // 'host' | 'joiner'
    this.code = code;
    this.stage = 'Preparing connection';
    this.started = Date.now();
    this.applied = 0;
    this.applyFailures = 0;
    this.candidateTypes = { local: [], remote: [] };
    this.onStatusChange = status => {
      this.stage = status;
      onStatusChange?.(status);
    };
    this.onChannelOpen = onChannelOpen || (() => {});
    this.onChannelMessage = onChannelMessage || (() => {});
    this.onControlMessage = onControlMessage || (() => {});
    this.onApplicationMessage = onApplicationMessage || (() => {});
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
    this.rejectedCandidates = new Set();
    this.candidateRetries = new Map();
    this.turnController = null;
    this.selectedRoute = { route: 'unknown' };
    this.pendingCandidates = [];
    this.disconnectTimer = null;
    this.disconnectStarted = null;
    this.channelOpened = false;
    this.trickleTimer = null;
    this.candidateCursor = 0;
    this.receiveQueue = Promise.resolve();
    SlipstreamPeer.lastSnapshot = null;
    this.events = SlipstreamPeer.diagnostics = [];

    // Standard STUN configuration for local candidate discovery
    this.rtcConfig = {
      iceTransportPolicy: 'all',
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
      this.turnController = new AbortController();
      const servers = await SlipstreamTurn.load(globalThis.SLIPSTREAM_TURN_CONFIG, {
        signal: this.turnController.signal, log: (event, details) => this.log(event, details),
      });
      if (this.isClosed) return;
      const directConfig = this.rtcConfig;
      this.rtcConfig = { ...directConfig, iceServers: [...directConfig.iceServers, ...servers] };
      try {
        this.pc = new RTCPeerConnection(this.rtcConfig);
      } catch (error) {
        if (!servers.length) throw error;
        this.log('TURN configuration', { outcome: 'browser-rejected' });
        this.rtcConfig = directConfig;
        this.pc = new RTCPeerConnection(this.rtcConfig);
      }

      this.pc.onicecandidate = ({ candidate }) => {
        if (candidate && !this.isClosed && (!this.channelOpened || this.pollController)) {
          this.pendingCandidates.push(candidate.toJSON());
          this.log('local ICE candidate gathered', { type: candidate.type, family: addressFamily(candidate.address) });
        }
      };
      this.pc.onicecandidateerror = event => this.log('ICE gathering error', { code: event.errorCode });
      this.pc.onicegatheringstatechange = () => this.log('ICE gathering', { state: this.pc.iceGatheringState });
      this.pc.onsignalingstatechange = () => this.log('signaling', { state: this.pc.signalingState });
      this.pc.oniceconnectionstatechange = () => {
        this.log('ICE connection', { state: this.pc.iceConnectionState });
        this.logCandidatePairs();
        this.checkConnection();
      };
      this.pc.onconnectionstatechange = () => {
        const state = this.pc.connectionState;
        this.log('peer connection', { state });
        this.checkConnection();
        if (!this.isClosed && this.disconnectStarted === null && !this.isChannelOpen() && (state === 'connecting' || state === 'connected')) {
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

  checkConnection() {
    if (this.isClosed) return;
    const { iceConnectionState: ice, connectionState: peer } = this.pc;
    if (ice === 'failed' || peer === 'failed') {
      this.connectionFailed(undefined, ice === 'failed' ? 'ice-failed' : 'peer-failed');
      return;
    }
    if (ice === 'disconnected' || peer === 'disconnected') {
      if (this.disconnectStarted !== null) return;
      this.disconnectStarted = Date.now();
      this.log('connection recovery started', { windowMs: DISCONNECT_RECOVERY_MS });
      this.onStatusChange('Reconnecting…');
      this.disconnectTimer = setTimeout(() => {
        this.checkConnection();
        if (!this.isClosed && this.disconnectStarted !== null) this.connectionFailed(undefined, 'recovery-timeout');
      }, DISCONNECT_RECOVERY_MS);
    } else if (this.disconnectStarted !== null && (!ice || ice === 'connected' || ice === 'completed')
      && (!peer || peer === 'connected')) {
      this.finishRecovery('recovered');
      this.onStatusChange(this.isChannelOpen() ? 'Connected' : 'Establishing secure connection…');
      this.logCandidatePairs();
    }
  }

  finishRecovery(outcome) {
    if (this.disconnectStarted === null) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.log('connection recovery ended', { outcome, durationMs: Date.now() - this.disconnectStarted });
    this.disconnectStarted = null;
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

    this.startHostPolling({ sdp: offer.sdp, type: offer.type });
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
  startHostPolling(pendingOffer) {
    this.startPolling(async signal => {
      if (pendingOffer) {
        await Api.sendOffer(this.code, pendingOffer, signal);
        pendingOffer = null;
        if (!signal.aborted) this.onStatusChange('Waiting for the other device…');
        return;
      }
      if (!this.pc.remoteDescription) {
        const answer = await Api.getAnswer(this.code, signal);
        if (signal.aborted || !answer) return;
        this.onStatusChange('Exchanging connection details…');
        await this.pc.setRemoteDescription(answer);
        if (!signal.aborted) this.onStatusChange('Establishing secure connection…');
      }
      if (!signal.aborted) await this.pollCandidates('joiner', signal);
    }, true);
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

  startPolling(step, immediate = false) {
    if (this.isClosed || this.isChannelOpen() || this.pollController) return;
    this.pollController = new AbortController();
    const { signal } = this.pollController;
    let failures = 0;
    const poll = async () => {
      try {
        let readError;
        try {
          await step(signal);
        } catch (error) {
          if (!transientSignalingError(error)) throw error;
          readError = error;
        }
        // Remove only acknowledged candidates. A transient POST failure retries
        // through the same bounded poll scheduler. Receivers deduplicate replays.
        while (this.pendingCandidates.length && !signal.aborted) {
          await Api.sendIceCandidate(this.code, this.role, this.pendingCandidates[0], signal);
          if (signal.aborted) return;
          this.pendingCandidates.shift();
          this.log('local ICE candidate acknowledged');
        }
        if (signal.aborted) return;
        if (readError) throw readError;
        this.logCandidatePairs();
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures++;
        this.log('signaling poll failed', { status: err.status, error: err.name, failures });
        if (!transientSignalingError(err) || failures >= 5) {
          if (this.channelOpened) this.stopPolling();
          else this.connectionFailed(err, 'signaling-failed');
          return;
        }
      }
      if (!signal.aborted) {
        const delay = Math.min(30000, this.pollIntervalMs * 2 ** failures);
        this.pollTimer = setTimeout(poll, delay);
      }
    };
    if (immediate) void poll();
    else this.pollTimer = setTimeout(poll, this.pollIntervalMs);
  }

  /**
   * Fetch and add new ICE candidates for the specified peer role.
   */
  async pollCandidates(peerRole, signal) {
    if (!this.pc || !this.pc.remoteDescription) return;

    const candidates = await Api.getIceCandidates(this.code, peerRole, this.candidateCursor, signal);
    for (const c of candidates) {
      if (signal.aborted) return;
      const candidateKey = JSON.stringify([c?.candidate, c?.sdpMid, c?.sdpMLineIndex, c?.usernameFragment]);
      if (!this.processedCandidates.has(candidateKey) && !this.rejectedCandidates.has(candidateKey)) {
        try {
          const candidate = new RTCIceCandidate(c);
          await this.pc.addIceCandidate(candidate);
          if (signal.aborted || this.isClosed) return;
          this.processedCandidates.add(candidateKey);
          this.candidateRetries.delete(candidateKey);
          this.applied++;
          this.log('remote ICE candidate accepted', { index: this.candidateCursor, type: candidate.type, family: addressFamily(candidate.address) });
        } catch (candidateErr) {
          if (signal.aborted) return;
          this.applyFailures++;
          this.log('remote ICE candidate rejected', { reason: candidateErr.name, index: this.candidateCursor });
          const attempts = (this.candidateRetries.get(candidateKey) || 0) + 1;
          if (candidateErr.name === 'InvalidStateError' && attempts < 3) {
            this.candidateRetries.set(candidateKey, attempts);
            throw candidateErr;
          }
          this.candidateRetries.delete(candidateKey);
          this.rejectedCandidates.add(candidateKey);
          this.log('remote ICE candidate skipped', { index: this.candidateCursor, reason: candidateErr.name, attempts });
        }
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
      this.channelOpened = true;
      this.log('data channel open');
      this.logCandidatePairs();
      this.iceTransport = this.pc?.sctp?.transport?.iceTransport;
      this.onPairChange = () => this.logCandidatePairs();
      this.iceTransport?.addEventListener?.('selectedcandidatepairchange', this.onPairChange);
      this.onStatusChange(this.disconnectStarted === null ? 'Connected' : 'Reconnecting…');
      // Give both devices a few normal polls to exchange late direct candidates.
      if (this.pollController) this.trickleTimer = setTimeout(() => this.stopPolling(), POST_OPEN_TRICKLE_MS);
      this.onChannelOpen(channel);
    };

    channel.onmessage = (event) => {
      this.receiveQueue = this.receiveQueue.then(() => this.handleIncomingData(event.data))
        .catch(error => this.onError(error));
    };

    channel.onclose = () => {
      this.stopPolling();
      this.log('data channel closed');
      this.close('data-channel-closed');
      this.onChannelClose();
    };

    channel.onerror = (err) => {
      this.connectionFailed(err.error, 'data-channel-error');
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
      else if (message?.protocol === 'slipstream-app') {
        const senderRole = this.role === 'host' ? 'joiner' : 'host';
        if (data.length <= 64 * 1024 && AppMessages.valid(message, senderRole)) this.onApplicationMessage(message);
      }
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
    this.events.push({ time: new Date().toISOString(), role: this.role, event, ...details });
    // Bound memory and retain the last attempt after its peer is closed.
    if (this.events.length > 200) this.events.shift();
  }

  snapshot() {
    return {
      stage: this.stage, signaling: this.pc?.signalingState, gathering: this.pc?.iceGatheringState,
      ice: this.pc?.iceConnectionState, connection: this.pc?.connectionState,
      channel: this.dataChannel?.readyState || 'unavailable', channelOpen: this.isChannelOpen(),
      applied: this.applied, applyFailures: this.applyFailures, candidateTypes: this.candidateTypes,
      rejected: this.rejectedCandidates.size, selectedRoute: this.selectedRoute,
      durationSeconds: Math.floor((Date.now() - this.started) / 1000),
    };
  }

  logCandidatePairs() {
    const pc = this.pc;
    if (!pc?.getStats || this.statsPending) return;
    this.statsPending = true;
    pc.getStats().then(report => {
      if (this.events !== SlipstreamPeer.diagnostics) return;
      const pairs = [];
      const candidates = [];
      let selectedId;
      report.forEach(row => {
        if (row.type === 'transport' && row.selectedCandidatePairId) {
          selectedId = row.selectedCandidatePairId;
        }
      });
      const selectedPair = report.get(selectedId);
      let local = report.get(selectedPair?.localCandidateId)?.candidateType;
      let remote = report.get(selectedPair?.remoteCandidateId)?.candidateType;
      if (!selectedPair) {
        // Safari versions can expose the selected pair through the ICE transport.
        const selected = pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
        local = selected?.local?.type;
        remote = selected?.remote?.type;
      }
      if (this.isClosed && !local && !remote && !Array.from(report.values()).some(row => row.type === 'candidate-pair')) {
        this.log('final ICE statistics unavailable');
        return;
      }
      const relayed = local === 'relay' || remote === 'relay';
      let kind = 'unknown';
      if (relayed) kind = 'relay';
      else if (local === 'host' && remote === 'host') kind = 'local';
      else if (local && remote && [local, remote].some(type => type === 'srflx' || type === 'prflx')) kind = 'nat';
      this.selectedRoute = {
        route: relayed ? 'relayed' : kind === 'unknown' ? 'unknown' : 'direct', kind,
        local, remote,
      };
      report.forEach((row, id) => {
        if (row.type === 'local-candidate' || row.type === 'remote-candidate') {
          candidates.push({ side: row.type, type: row.candidateType, protocol: row.protocol, family: addressFamily(row.address) });
        }
        if (row.type === 'candidate-pair') pairs.push({
          selected: selectedId ? id === selectedId : undefined,
          state: row.state, nominated: !!row.nominated,
          priority: row.priority, bytesSent: row.bytesSent, bytesReceived: row.bytesReceived,
          consentRequestsSent: row.consentRequestsSent, currentRoundTripTime: row.currentRoundTripTime,
          local: report.get(row.localCandidateId)?.candidateType,
          remote: report.get(row.remoteCandidateId)?.candidateType,
          requestsSent: row.requestsSent, responsesReceived: row.responsesReceived,
          requestsReceived: row.requestsReceived, responsesSent: row.responsesSent,
        });
      });
      for (const side of ['local', 'remote']) {
        this.candidateTypes[side] = [...new Set(candidates.filter(c => c.side === side + '-candidate').map(c => c.type))];
      }
      this.log('ICE candidate pairs', { selectedRoute: this.selectedRoute, candidates, pairs });
      if (this.isClosed) SlipstreamPeer.lastSnapshot.selectedRoute = this.selectedRoute;
    }).catch(() => {
      this.log('ICE statistics unavailable');
    }).finally(() => { this.statsPending = false; });
  }

  connectionFailed(error, reason = 'connection-setup-failed') {
    if (this.isClosed) return;
    this.logCandidatePairs();
    this.log('connection failed', {
      error: error?.name, status: error?.status, ice: this.pc?.iceConnectionState,
      signaling: this.pc?.signalingState, remoteCandidatesRead: this.candidateCursor,
      localCandidatesPending: this.pendingCandidates.length,
    });
    this.onStatusChange(this.channelOpened ? 'Connection lost' : "Couldn't connect to device");
    this.close(reason);
    this.onError(error || new Error("Couldn't connect to device"));
  }

  stopPolling() {
    clearTimeout(this.trickleTimer);
    this.trickleTimer = null;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollController?.abort();
    this.pollController = null;
  }

  /**
   * Cleanly close all WebRTC and signaling resources.
   */
  close(reason = 'session-ended') {
    if (this.isClosed) return;
    this.logCandidatePairs();
    this.finishRecovery(reason);
    this.log('connection closed', { reason, channel: this.dataChannel?.readyState || 'unavailable' });
    SlipstreamPeer.lastSnapshot = { ...this.snapshot(), reason, channel: 'closed', channelOpen: false };
    this.isClosed = true;
    this.turnController?.abort();
    this.iceTransport?.removeEventListener?.('selectedcandidatepairchange', this.onPairChange);
    this.iceTransport = null;
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
    this.rejectedCandidates.clear();
    this.candidateRetries.clear();
  }
}
