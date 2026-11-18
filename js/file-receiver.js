/**
 * Receives a file over an ordered RTCDataChannel. Counterpart of FileSender.
 *
 * Control messages are JSON strings.
 *   Incoming:
 *   - file-offer:    { transferId, name, mimeType, size, sha256 }
 *   - file-complete: { transferId }
 *   - file-cancel:   { transferId, reason? }
 *   Outgoing:
 *   - file-accept / file-reject / file-cancel: { transferId, reason? }
 *   - file-verified: { transferId }   (sent only after the SHA-256 digest matches)
 *
 * File contents arrive as raw binary messages (16 KiB chunks).
 *
 * Flow: file-offer -> onOffer -> accept() or reject() -> chunks -> file-complete
 *       -> size check -> SHA-256 check -> onComplete -> download().
 * The file is never offered for download unless every check passes.
 *
 * Callbacks (all optional):
 *   onOffer({ transferId, name, mimeType, size, sha256 })
 *   onProgress({ transferId, bytesReceived, totalBytes, progress })
 *   onComplete({ transferId, name, mimeType, size, blob })
 *   onCancel({ transferId, reason, byRemote })
 *   onError({ transferId, error })
 */
class FileReceiver {
  constructor(channel, {
    onOffer = () => {},
    onProgress = () => {},
    onComplete = () => {},
    onCancel = () => {},
    onError = () => {},
    maxFileSize = Infinity,
  } = {}) {
    if (!channel || typeof channel.send !== 'function' || typeof channel.addEventListener !== 'function') {
      throw new TypeError('FileReceiver requires an RTCDataChannel-like object');
    }
    for (const [name, fn] of Object.entries({ onOffer, onProgress, onComplete, onCancel, onError })) {
      if (typeof fn !== 'function') {
        throw new TypeError(`${name} must be a function`);
      }
    }
    if (!(maxFileSize > 0)) {
      throw new RangeError('maxFileSize must be a positive number');
    }

    this.channel = channel;
    this.callbacks = { onOffer, onProgress, onComplete, onCancel, onError };
    this.maxFileSize = maxFileSize;
    this.activeTransfer = null;
    this.completed = null; // { name, blob } of the last verified file
    this.disposed = false;

    // RTCDataChannel defaults to 'blob' in browsers. The sender sends ArrayBuffers,
    // and ArrayBuffer is the simplest type to count and to hash.
    this.channel.binaryType = 'arraybuffer';

    this.handleMessage = this.handleMessage.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleError = this.handleError.bind(this);
    this.channel.addEventListener('message', this.handleMessage);
    this.channel.addEventListener('close', this.handleClose);
    this.channel.addEventListener('error', this.handleError);
  }

  /** Accept the pending offer. The sender starts sending chunks after this. */
  accept() {
    const transfer = this.activeTransfer;
    if (!transfer || transfer.state !== 'offered') {
      return false;
    }
    transfer.state = 'receiving';
    if (!this.sendControl('file-accept', transfer.id)) {
      this.fail(transfer, 'Could not send acceptance: data channel is not open', false);
      return false;
    }
    this.reportProgress(transfer);
    return true;
  }

  /** Decline the pending offer. No bytes are ever received. */
  reject(reason = 'Receiver declined the file') {
    const transfer = this.activeTransfer;
    if (!transfer || transfer.state !== 'offered') {
      return false;
    }
    this.sendControl('file-reject', transfer.id, reason);
    this.discard(transfer);
    return true;
  }

  /** Cancel whatever is in progress and discard partial data on this side. */
  cancel(reason = 'Transfer cancelled by receiver') {
    const transfer = this.activeTransfer;
    if (!transfer) {
      return false;
    }
    if (transfer.state === 'offered') {
      return this.reject(reason);
    }
    this.sendControl('file-cancel', transfer.id, reason);
    this.discard(transfer);
    this.emit('onCancel', { transferId: transfer.id, reason, byRemote: false });
    return true;
  }

  /**
   * Save the last verified file. Call this from a user action (button click).
   * The temporary object URL is revoked shortly after the download starts.
   */
  download() {
    if (!this.completed) {
      return false;
    }
    const { name, blob } = this.completed;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  /** Drop the reference to the last verified file so its memory can be freed. */
  release() {
    this.completed = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.activeTransfer) {
        this.cancel('File receiver disposed');
      }
    } finally {
      this.release();
      this.channel.removeEventListener('message', this.handleMessage);
      this.channel.removeEventListener('close', this.handleClose);
      this.channel.removeEventListener('error', this.handleError);
    }
  }

  // ---- channel events ----

  handleMessage(event) {
    if (this.disposed) return;
    if (typeof event.data === 'string') {
      this.handleControl(event.data);
    } else {
      this.handleChunk(event.data);
    }
  }

  handleClose() {
    const transfer = this.activeTransfer;
    if (transfer) {
      this.fail(transfer, 'Data channel closed during file transfer', false);
    }
  }

  handleError() {
    const transfer = this.activeTransfer;
    if (transfer) {
      this.fail(transfer, 'Data channel failed during file transfer', false);
    }
  }

  // ---- control messages ----

  handleControl(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'file-offer':
        this.handleOffer(message);
        break;
      case 'file-complete':
        if (this.isActive(message.transferId)) {
          this.finish(this.activeTransfer);
        }
        break;
      case 'file-cancel':
        if (this.isActive(message.transferId)) {
          const transfer = this.activeTransfer;
          const reason = typeof message.reason === 'string' && message.reason
            ? message.reason
            : 'Sender cancelled the transfer';
          this.discard(transfer);
          this.emit('onCancel', { transferId: transfer.id, reason, byRemote: true });
        }
        break;
      default:
        break;
    }
  }

  handleOffer(message) {
    const { transferId, name, mimeType, size, sha256 } = message;
    if (typeof transferId !== 'string' || !transferId) return;

    const valid = typeof name === 'string'
      && typeof mimeType === 'string'
      && Number.isSafeInteger(size) && size >= 0
      && typeof sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(sha256);
    if (!valid) {
      this.sendControl('file-reject', transferId, 'Invalid file offer');
      return;
    }
    if (this.activeTransfer) {
      this.sendControl('file-reject', transferId, 'Receiver is busy with another transfer');
      return;
    }
    if (size > this.maxFileSize) {
      this.sendControl('file-reject', transferId, 'File is too large for this receiver');
      return;
    }

    this.release(); // a new offer replaces the previous verified file
    const transfer = {
      id: transferId,
      name: this.sanitizeFileName(name),
      mimeType: mimeType || 'application/octet-stream',
      size,
      sha256: sha256.toLowerCase(),
      state: 'offered', // offered -> receiving -> verifying
      chunks: [],
      bytesReceived: 0,
    };
    this.activeTransfer = transfer;
    this.emit('onOffer', {
      transferId: transfer.id,
      name: transfer.name,
      mimeType: transfer.mimeType,
      size: transfer.size,
      sha256: transfer.sha256,
    });
  }

  // ---- file data ----

  handleChunk(data) {
    const transfer = this.activeTransfer;
    if (!transfer || transfer.state !== 'receiving') return;

    const length = data && (data.byteLength !== undefined ? data.byteLength : data.size);
    if (!Number.isSafeInteger(length)) return;

    if (transfer.bytesReceived + length > transfer.size) {
      this.fail(transfer, 'Received more data than the file offer announced', true);
      return;
    }
    transfer.chunks.push(data); // ArrayBuffer (or Blob if binaryType was changed); both are valid Blob parts
    transfer.bytesReceived += length;
    this.reportProgress(transfer);
  }

  async finish(transfer) {
    if (transfer.state !== 'receiving') return;

    if (transfer.bytesReceived !== transfer.size) {
      this.fail(
        transfer,
        `Transfer incomplete: expected ${transfer.size} bytes, received ${transfer.bytesReceived}`,
        true
      );
      return;
    }
    transfer.state = 'verifying';

    let actualHash;
    let blob;
    try {
      if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error('Web Crypto is required to verify the file (use HTTPS or localhost)');
      }
      blob = new Blob(transfer.chunks, { type: transfer.mimeType });
      actualHash = this.toHex(await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    } catch (error) {
      this.fail(transfer, error && error.message ? error.message : 'Could not verify the file', true);
      return;
    }

    // The transfer may have been cancelled or the channel closed while hashing.
    if (this.activeTransfer !== transfer) return;

    if (actualHash !== transfer.sha256) {
      this.fail(transfer, 'Integrity check failed: the received file does not match the original', true);
      return;
    }

    this.activeTransfer = null;
    transfer.chunks = [];
    this.completed = { name: transfer.name, blob };
    this.sendControl('file-verified', transfer.id);
    this.reportProgress({ ...transfer, bytesReceived: transfer.size }, true);
    this.emit('onComplete', {
      transferId: transfer.id,
      name: transfer.name,
      mimeType: transfer.mimeType,
      size: transfer.size,
      blob,
    });
  }

  // ---- helpers ----

  isActive(transferId) {
    return !!this.activeTransfer && this.activeTransfer.id === transferId;
  }

  /** Stop the transfer, drop partial data, and report an error. Never reports success. */
  fail(transfer, message, notifyPeer) {
    if (this.activeTransfer !== transfer) return;
    if (notifyPeer) {
      this.sendControl('file-cancel', transfer.id, message);
    }
    this.discard(transfer);
    this.emit('onError', { transferId: transfer.id, error: new Error(message) });
  }

  discard(transfer) {
    transfer.chunks = [];
    transfer.bytesReceived = 0;
    if (this.activeTransfer === transfer) {
      this.activeTransfer = null;
    }
  }

  sendControl(type, transferId, reason) {
    if (this.channel.readyState !== 'open') return false;
    try {
      const payload = { type, transferId };
      if (reason) payload.reason = reason;
      this.channel.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  reportProgress(transfer, completed = false) {
    this.emit('onProgress', {
      transferId: transfer.id,
      bytesReceived: transfer.bytesReceived,
      totalBytes: transfer.size,
      progress: completed ? 100 : (transfer.size === 0 ? 0 : Math.floor((transfer.bytesReceived / transfer.size) * 100)),
    });
  }

  emit(name, payload) {
    try {
      this.callbacks[name](payload);
    } catch (error) {
      console.error(`FileReceiver ${name} callback threw`, error);
    }
  }

  /** The sender controls the name, so strip path separators and control characters. */
  sanitizeFileName(name) {
    const cleaned = name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 255);
    return cleaned || 'download';
  }

  toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}