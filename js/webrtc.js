/**
 * Slipstream WebRTC Connection Manager
 * Manages RTCPeerConnection, signaling exchange, and RTCDataChannel (§4, §5, §10, §12).
 * Direct peer-to-peer data transport; zero byte routing through server.
 */

class SlipstreamPeer {
  constructor({ role, code, onStatusChange, onChannelOpen, onChannelMessage, onChannelClose, onError }) {
    this.role = role; // 'host' | 'joiner'
    this.code = code;
    this.onStatusChange = onStatusChange || (() => {});
    this.onChannelOpen = onChannelOpen || (() => {});
    this.onChannelMessage = onChannelMessage || (() => {});
    this.onChannelClose = onChannelClose || (() => {});
    this.onError = onError || (() => {});

    this.pc = null;
    this.dataChannel = null;
    this.pollingInterval = null;
    this.isClosed = false;
    this.processedCandidates = new Set();
    this.candidateCursor = 0;

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
      this.onChannelMessage(event.data);
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
   * Send data through the data channel.
   */
  send(data) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }
    this.dataChannel.send(data);
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

    if (this.dataChannel) {
      try {
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
