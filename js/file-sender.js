class SlipstreamFileSender extends SlipstreamTransfer {
  constructor(options) {
    super('sender', options);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async start(file) {
    if (this.destroyed || this.active) throw new Error('Sender is unavailable or already transferring.');
    if (!this.peer.isChannelOpen()) throw new Error('Data channel is closed.');
    if (!(file instanceof Blob) || file.size > this.maxFileSize) throw new Error('Select a file within the size limit.');
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 requires HTTPS or localhost.');

    const channel = this.peer.dataChannel;
    const transfer = {
      id: crypto.randomUUID(), file, bytesSent: 0, chunksSent: 0, confirmed: 0,
      abort: new AbortController(), channel, previousThreshold: channel.bufferedAmountLowThreshold,
    };
    const done = new Promise(resolve => { transfer.resolve = resolve; });
    this.active = transfer;
    this.enter('hashing');
    this.prepareOffer(transfer);
    return done;
  }

  async prepareOffer(transfer) {
    const { file, channel } = transfer;
    try {
      const digest = await TransferProtocol.digest(file);
      if (this.active !== transfer) return;
      const chunkSize = TransferProtocol.chunkSize;
      transfer.metadata = {
        name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream',
        lastModified: file.lastModified ?? 0, chunkSize, totalChunks: Math.ceil(file.size / chunkSize),
        hash: { algorithm: 'SHA-256', value: digest },
      };
      if (!TransferProtocol.validMetadata(transfer.metadata)) {
        this.fail('INVALID_METADATA', 'The selected file has invalid metadata.', false);
        return;
      }
      channel.bufferedAmountLowThreshold = 256 * 1024;
      this.enter('awaiting-acceptance');
      transfer.timer = setTimeout(() => this.cancel('timeout'), this.timeoutMs);
      this.send('file-offer', transfer.id, { file: transfer.metadata });
    } catch {
      if (this.active === transfer) this.fail('INTERNAL_ERROR', 'Could not prepare the file offer.', false);
    }
  }

  finish(state, details) {
    if (this.active) this.active.channel.bufferedAmountLowThreshold = this.active.previousThreshold;
    super.finish(state, details);
  }

  control(message) {
    const t = this.active;
    switch (message.type) {
      case 'file-reject':
        if (t.state === 'awaiting-acceptance' && TransferProtocol.rejectReasons.includes(message.reason)) {
          this.finish('rejected', { reason: message.reason });
          return;
        }
        break;
      case 'file-accept':
        if (t.state === 'sending' || t.state === 'awaiting-verification') return;
        if (t.state !== 'awaiting-acceptance') break;
        clearTimeout(t.timer);
        this.enter('sending');
        this.sendChunks(t).catch(() => {
          if (this.active === t) this.fail('INTERNAL_ERROR', 'File transmission was interrupted.');
        });
        return;
      case 'file-progress': {
        const bytes = message.bytesReceived;
        if (!['sending', 'awaiting-verification'].includes(t.state) || !Number.isSafeInteger(bytes)
          || bytes < t.confirmed || bytes > t.bytesSent || message.totalBytes !== t.file.size) break;
        t.confirmed = bytes;
        this.onProgress({ transferId: t.id, bytesReceived: bytes, totalBytes: t.file.size });
        return;
      }
      case 'file-complete-ack':
        if (t.state !== 'awaiting-verification' || message.status !== 'verified'
          || message.bytesReceived !== t.file.size || message.sha256 !== t.metadata.hash.value) break;
        this.finish('completed', { bytesReceived: message.bytesReceived, sha256: message.sha256 });
        return;
    }
    this.fail('INVALID_MESSAGE', 'Unexpected or invalid receiver control.');
  }

  async sendChunks(t) {
    this.send('file-start', t.id);
    while (t.bytesSent < t.file.size) {
      if (this.active !== t) return;
      if (!this.peer.isChannelOpen()) throw new Error('Channel closed');
      if (this.peer.bufferedAmount > 1024 * 1024) await this.waitForBuffer(t);
      if (this.active !== t) return;
      const chunk = await t.file.slice(t.bytesSent, t.bytesSent + TransferProtocol.chunkSize).arrayBuffer();
      if (this.active !== t) return;
      this.peer.sendBinary(chunk);
      t.bytesSent += chunk.byteLength;
      t.chunksSent++;
    }
    this.enter('awaiting-verification');
    t.timer = setTimeout(() => this.cancel('timeout'), this.timeoutMs);
    this.send('file-complete', t.id, { bytesSent: t.bytesSent, chunksSent: t.chunksSent, sha256: t.metadata.hash.value });
  }

  waitForBuffer(t) {
    const channel = this.peer.dataChannel;
    const signal = t.abort.signal;
    return new Promise((resolve, reject) => {
      const check = () => {
        const interrupted = signal.aborted || channel.readyState !== 'open';
        if (!interrupted && channel.bufferedAmount > channel.bufferedAmountLowThreshold) return;
        channel.removeEventListener('bufferedamountlow', check);
        signal.removeEventListener('abort', check);
        if (interrupted) reject(new Error('Transfer interrupted'));
        else resolve();
      };
      channel.addEventListener('bufferedamountlow', check);
      signal.addEventListener('abort', check);
      check();
    });
  }
}
