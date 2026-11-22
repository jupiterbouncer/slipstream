class SlipstreamFileReceiver extends SlipstreamTransfer {
  constructor(options) {
    super('receiver', options);
    this.onOffer = options.onOffer || (() => {});
    this.seenOffers = new Set();
  }

  offer({ transferId: id, file }) {
    if (this.seenOffers.has(id)) return;
    this.seenOffers.add(id);
    let reason;
    if (this.active) reason = 'receiver-busy';
    else if (!TransferProtocol.validMetadata(file)) reason = 'invalid-metadata';
    else if (file.size > this.maxFileSize) reason = 'file-too-large';
    if (reason) {
      this.send('file-reject', id, { reason });
      return;
    }
    this.active = { id, file, chunks: [], bytes: 0, reported: 0, lastReport: performance.now() };
    this.enter('awaiting-decision');
    this.onOffer(file);
  }

  accept() {
    if (this.active?.state !== 'awaiting-decision') return;
    try {
      this.enter('ready');
      this.send('file-accept', this.active.id);
    } catch {
      this.channelClosed();
    }
  }

  reject(reason = 'user-declined') {
    if (this.active?.state !== 'awaiting-decision') return;
    try {
      this.send('file-reject', this.active.id, { reason });
      this.finish('rejected', { reason });
    } catch {
      this.channelClosed();
    }
  }

  control(message) {
    const t = this.active;
    if (message.type === 'file-start') {
      if (t.state === 'receiving') return;
      if (t.state === 'ready') {
        this.enter('receiving');
        return;
      }
    }
    if (message.type === 'file-complete') {
      if (t.state === 'verifying') return;
      if (t.state === 'receiving') {
        this.verify(t, message).catch(() => {
          if (this.active === t) this.fail('INTERNAL_ERROR', 'Could not verify the received file.');
        });
        return;
      }
    }
    this.fail('INVALID_MESSAGE', 'Unexpected sender control.');
  }

  handleBinaryChunk(chunk) {
    const t = this.active;
    if (!t) return; // Includes already-queued chunks after a receiver cancellation.
    if (t.state !== 'receiving') return this.fail('UNEXPECTED_BINARY', 'File bytes arrived outside a transfer.');
    const expected = Math.min(t.file.chunkSize, t.file.size - t.bytes);
    if (!(chunk instanceof ArrayBuffer) || expected === 0 || chunk.byteLength !== expected) {
      return this.fail('INVALID_CHUNK_SIZE', 'A file chunk had an unexpected length.');
    }
    t.chunks.push(chunk);
    t.bytes += chunk.byteLength;
    const progress = { bytesReceived: t.bytes, totalBytes: t.file.size };
    this.onProgress({ transferId: t.id, ...progress });
    const now = performance.now();
    if (t.bytes === t.file.size || now - t.lastReport >= 250 || t.bytes - t.reported >= t.file.size / 100) {
      try {
        this.send('file-progress', t.id, progress);
        t.lastReport = now;
        t.reported = t.bytes;
      } catch {
        this.channelClosed();
      }
    }
  }

  async verify(t, message) {
    const file = t.file;
    if (message.bytesSent !== file.size || t.bytes !== file.size
      || message.chunksSent !== file.totalChunks || t.chunks.length !== file.totalChunks) {
      return this.fail('SIZE_MISMATCH', 'The transfer ended with missing or extra data.');
    }
    if (message.sha256 !== file.hash.value) return this.fail('HASH_MISMATCH', 'The completion digest differs from the offer.');
    this.enter('verifying');
    if (!file.size) this.send('file-progress', t.id, { bytesReceived: 0, totalBytes: 0 });
    const blob = new Blob(t.chunks, { type: file.mimeType });
    t.chunks.length = 0;
    const digest = await TransferProtocol.digest(blob);
    if (this.active !== t) return; // Cancellation or disconnect while hashing.
    if (digest !== file.hash.value) return this.fail('HASH_MISMATCH', 'SHA-256 verification failed.');
    this.send('file-complete-ack', t.id, { status: 'verified', bytesReceived: t.bytes, sha256: digest });
    this.finish('completed', { name: file.name, blob, sha256: digest, bytesReceived: t.bytes });
  }

  destroy() {
    super.destroy();
    this.seenOffers.clear();
  }
}
