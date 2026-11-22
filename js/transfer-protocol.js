// Shared version 1 envelope, limits and terminal cleanup for the two file engines.
const TransferProtocol = {
  chunkSize: 16384,
  maxFileSize: 100 * 1024 * 1024,
  validId: id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
  rejectReasons: ['user-declined', 'file-too-large', 'unsupported-file', 'receiver-busy', 'invalid-metadata'],
  async digest(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  },
  validMetadata(file) {
    return file && typeof file.name === 'string' && file.name.trim().length > 0 && file.name.length <= 255
      && Number.isSafeInteger(file.size) && file.size >= 0
      && typeof file.mimeType === 'string' && file.mimeType.length > 0 && file.mimeType.length <= 255
      && Number.isSafeInteger(file.lastModified)
      && file.chunkSize === this.chunkSize && file.totalChunks === Math.ceil(file.size / this.chunkSize)
      && file.hash?.algorithm === 'SHA-256' && typeof file.hash.value === 'string'
      && /^[0-9a-f]{64}$/.test(file.hash.value);
  },
};

class SlipstreamTransfer {
  constructor(role, { peer, maxFileSize = TransferProtocol.maxFileSize, onStateChange = () => {},
    onProgress = () => {}, onComplete = () => {}, onError = () => {} }) {
    Object.assign(this, { role, peer, maxFileSize, onStateChange, onProgress, onComplete, onError });
    this.active = null;
    this.destroyed = false;
    this.lastCancelled = null;
  }

  send(type, transferId, fields = {}) {
    this.peer.sendControl({ protocol: 'slipstream', version: 1, type, transferId, ...fields });
  }

  enter(state) {
    this.active.state = state;
    this.onStateChange(state);
  }

  finish(state, details = {}) {
    const transfer = this.active;
    if (!transfer) return;
    this.active = null;
    clearTimeout(transfer.timer);
    transfer.abort?.abort();
    if (transfer.chunks) transfer.chunks.length = 0;
    const result = { transferId: transfer.id, ...details };
    transfer.resolve?.({ state, ...result });
    this.onStateChange(state, result);
    if (state === 'completed') this.onComplete(result);
    if (state === 'failed') this.onError(new Error(result.message));
  }

  fail(code, message, notify = true) {
    if (!this.active) return;
    try {
      if (notify && this.peer.isChannelOpen()) this.send('file-error', this.active.id, { code, message });
    } catch {
      // The channel can close between its readyState check and send().
    }
    this.finish('failed', { code, message });
  }

  // Validates the envelope before either engine can act on the payload.
  handleControlMessage(message) {
    if (this.destroyed || message?.protocol !== 'slipstream' || !TransferProtocol.validId(message.transferId)) return;
    const id = message.transferId;
    try {
      if (message.version !== 1) {
        if (message.type !== 'file-error') {
          const reason = 'Unsupported transfer protocol version.';
          if (this.active?.id === id) this.fail('UNSUPPORTED_VERSION', reason);
          else this.send('file-error', id, { code: 'UNSUPPORTED_VERSION', message: reason });
        }
        return;
      }
      if (message.type === 'file-cancel-ack') return;
      if (message.type === 'file-offer' && this.role === 'receiver') {
        this.offer(message);
        return;
      }
      if (id !== this.active?.id) {
        // Crossed cancellation messages can arrive after local cleanup.
        if (message.type === 'file-cancel' && id === this.lastCancelled && this.validCancellation(message)) {
          this.send('file-cancel-ack', id, { cancelledBy: message.cancelledBy });
        }
        return;
      }
      if (message.type === 'file-error') {
        const code = typeof message.code === 'string' ? message.code : 'INVALID_MESSAGE';
        this.fail(code, typeof message.message === 'string' ? message.message.slice(0, 200) : 'Peer reported a transfer error.', false);
      } else if (message.type === 'file-cancel' && this.validCancellation(message)) {
        this.send('file-cancel-ack', id, { cancelledBy: message.cancelledBy });
        this.finish('cancelled', { reason: message.reason });
      } else {
        this.control(message);
      }
    } catch {
      this.fail('INTERNAL_ERROR', 'Could not exchange transfer controls.', false);
    }
  }

  validCancellation(message) {
    return message.cancelledBy === (this.role === 'sender' ? 'receiver' : 'sender')
      && ['user-cancelled', 'timeout'].includes(message.reason);
  }

  cancel(reason = 'user-cancelled') {
    if (!this.active) return;
    if (!this.peer.isChannelOpen()) return this.channelClosed();
    const { id, state } = this.active;
    this.lastCancelled = id;
    try {
      if (state !== 'hashing') this.send('file-cancel', id, { cancelledBy: this.role, reason });
      if (reason === 'timeout') this.finish('failed', { reason, message: 'The peer did not respond in time.' });
      else this.finish('cancelled', { reason });
    } catch {
      this.channelClosed();
    }
  }

  channelClosed() {
    this.fail('INTERNAL_ERROR', 'Connection lost during file transfer.', false);
  }

  destroy() {
    this.cancel();
    this.destroyed = true;
  }
}
