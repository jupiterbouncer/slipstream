/**
 * Sends a file over an ordered RTCDataChannel.
 *
 * Control messages are JSON strings:
 * - file-offer: { transferId, name, mimeType, size, sha256 }
 * - file-accept / file-reject / file-cancel: { transferId, reason? }
 * - file-complete: { transferId }
 *
 * File contents are sent as raw binary messages in 16 KiB chunks.
 */
class FileSender {
  constructor(channel, { onProgress = () => {}, lowWaterMark = 64 * 1024 } = {}) {
    if (!channel || typeof channel.send !== 'function' || typeof channel.addEventListener !== 'function') {
      throw new TypeError('FileSender requires an RTCDataChannel-like object');
    }
    if (!Number.isSafeInteger(lowWaterMark) || lowWaterMark < 0) {
      throw new RangeError('lowWaterMark must be a non-negative safe integer');
    }
    if (typeof onProgress !== 'function') {
      throw new TypeError('onProgress must be a function');
    }

    this.channel = channel;
    this.onProgress = onProgress;
    this.lowWaterMark = lowWaterMark;
    this.activeTransfer = null;
    this.disposed = false;

    this.handleMessage = this.handleMessage.bind(this);
    this.handleClose = this.handleClose.bind(this);
    this.handleError = this.handleError.bind(this);
    this.channel.addEventListener('message', this.handleMessage);
    this.channel.addEventListener('close', this.handleClose);
    this.channel.addEventListener('error', this.handleError);
  }

  async send(file) {
    if (this.disposed) {
      throw new Error('FileSender has been disposed');
    }
    if (this.activeTransfer) {
      throw new Error('A file transfer is already in progress');
    }
    if (!file || typeof file.slice !== 'function' || typeof file.arrayBuffer !== 'function'
      || !Number.isSafeInteger(file.size) || file.size < 0) {
      throw new TypeError('send() requires a File-like object');
    }
    this.assertChannelOpen();
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error('Web Crypto is required to calculate the file SHA-256 digest');
    }

    const transfer = {
      id: this.createTransferId(),
      abortController: new AbortController(),
      acceptanceResolver: null,
      acceptanceRejecter: null,
      offered: false,
      remoteCancelled: false,
      localCancelled: false,
      previousLowThreshold: this.channel.bufferedAmountLowThreshold,
    };
    this.activeTransfer = transfer;

    let bytesSent = 0;
    const metadata = {
      transferId: transfer.id,
      name: file.name || 'unnamed',
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
    };

    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      this.throwIfAborted(transfer);
      metadata.sha256 = this.toHex(digest);

      this.channel.bufferedAmountLowThreshold = this.lowWaterMark;
      this.reportProgress(bytesSent, file.size, transfer.id);
      this.throwIfAborted(transfer);
      this.channel.send(JSON.stringify({ type: 'file-offer', ...metadata }));
      transfer.offered = true;
      await this.waitForAcceptance(transfer);
      this.throwIfAborted(transfer);

      for (let offset = 0; offset < file.size; offset += 16 * 1024) {
        this.throwIfAborted(transfer);
        this.assertChannelOpen();
        const chunk = await file.slice(offset, Math.min(offset + 16 * 1024, file.size)).arrayBuffer();
        this.throwIfAborted(transfer);
        this.channel.send(chunk);
        bytesSent += chunk.byteLength;
        this.reportProgress(bytesSent, file.size, transfer.id);

        if (offset + chunk.byteLength < file.size) {
          await this.waitForBufferSpace(transfer);
        }
      }

      this.throwIfAborted(transfer);
      this.assertChannelOpen();
      this.channel.send(JSON.stringify({ type: 'file-complete', transferId: transfer.id }));
      if (file.size === 0) {
        this.reportProgress(0, 0, transfer.id, true);
      }

      return { transferId: transfer.id, bytesSent, totalBytes: file.size, sha256: metadata.sha256 };
    } catch (error) {
      if (transfer.offered && !transfer.remoteCancelled && !transfer.localCancelled
        && this.channel.readyState === 'open') {
        try {
          this.channel.send(JSON.stringify({
            type: 'file-cancel',
            transferId: transfer.id,
            reason: error && error.message ? error.message : 'Transfer stopped',
          }));
        } catch (cancelError) {
          throw new AggregateError([error, cancelError], 'File transfer failed and cancellation could not be sent');
        }
      }
      throw error;
    } finally {
      this.channel.bufferedAmountLowThreshold = transfer.previousLowThreshold;
      this.activeTransfer = null;
    }
  }

  cancel(reason = 'Transfer cancelled by sender') {
    const transfer = this.activeTransfer;
    if (!transfer || transfer.abortController.signal.aborted) {
      return false;
    }
    transfer.localCancelled = true;

    try {
      if (transfer.offered && this.channel.readyState === 'open') {
        this.channel.send(JSON.stringify({
          type: 'file-cancel',
          transferId: transfer.id,
          reason,
        }));
      }
    } finally {
      transfer.abortController.abort(this.createAbortError(reason));
      if (transfer.acceptanceRejecter) {
        transfer.acceptanceRejecter(this.abortReason(transfer));
      }
    }
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.cancel('File sender disposed');
    } finally {
      this.channel.removeEventListener('message', this.handleMessage);
      this.channel.removeEventListener('close', this.handleClose);
      this.channel.removeEventListener('error', this.handleError);
    }
  }

  handleMessage(event) {
    if (!this.activeTransfer || typeof event.data !== 'string') return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.transferId !== this.activeTransfer.id) return;

    if (message.type === 'file-accept' && this.activeTransfer.acceptanceResolver) {
      this.activeTransfer.acceptanceResolver();
      this.activeTransfer.acceptanceResolver = null;
      this.activeTransfer.acceptanceRejecter = null;
    } else if (message.type === 'file-reject' && this.activeTransfer.acceptanceRejecter) {
      this.activeTransfer.remoteCancelled = true;
      this.activeTransfer.acceptanceRejecter(new Error(message.reason || 'Receiver declined the file'));
      this.activeTransfer.acceptanceResolver = null;
      this.activeTransfer.acceptanceRejecter = null;
    } else if (message.type === 'file-cancel') {
      this.activeTransfer.remoteCancelled = true;
      this.activeTransfer.abortController.abort(
        this.createAbortError(message.reason || 'Receiver cancelled the transfer')
      );
      if (this.activeTransfer.acceptanceRejecter) {
        this.activeTransfer.acceptanceRejecter(this.abortReason(this.activeTransfer));
      }
    }
  }

  handleClose() {
    if (this.activeTransfer) {
      this.activeTransfer.abortController.abort(new Error('Data channel closed during file transfer'));
      if (this.activeTransfer.acceptanceRejecter) {
        this.activeTransfer.acceptanceRejecter(this.abortReason(this.activeTransfer));
      }
    }
  }

  handleError() {
    if (this.activeTransfer) {
      this.activeTransfer.abortController.abort(new Error('Data channel failed during file transfer'));
      if (this.activeTransfer.acceptanceRejecter) {
        this.activeTransfer.acceptanceRejecter(this.abortReason(this.activeTransfer));
      }
    }
  }

  waitForAcceptance(transfer) {
    return new Promise((resolve, reject) => {
      const signal = transfer.abortController.signal;
      const finish = (error) => {
        signal.removeEventListener('abort', onAbort);
        transfer.acceptanceResolver = null;
        transfer.acceptanceRejecter = null;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(this.abortReason(transfer));
      transfer.acceptanceResolver = () => finish();
      transfer.acceptanceRejecter = (error) => finish(error);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  waitForBufferSpace(transfer) {
    return new Promise((resolve, reject) => {
      const signal = transfer.abortController.signal;
      const cleanup = () => {
        this.channel.removeEventListener('bufferedamountlow', check);
        this.channel.removeEventListener('close', check);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (signal.aborted) {
          finish(this.abortReason(transfer));
        } else if (this.channel.readyState !== 'open') {
          finish(new Error('Data channel closed during file transfer'));
        } else if (this.channel.bufferedAmount <= this.lowWaterMark) {
          finish();
        }
      };
      const onAbort = () => finish(this.abortReason(transfer));

      this.channel.addEventListener('bufferedamountlow', check);
      this.channel.addEventListener('close', check);
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  reportProgress(bytesSent, totalBytes, transferId, completed = false) {
    this.onProgress({
      transferId,
      bytesSent,
      totalBytes,
      progress: completed ? 100 : (totalBytes === 0 ? 0 : Math.floor((bytesSent / totalBytes) * 100)),
    });
  }

  assertChannelOpen() {
    if (this.channel.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }
  }

  throwIfAborted(transfer) {
    if (transfer.abortController.signal.aborted) {
      throw this.abortReason(transfer);
    }
  }

  abortReason(transfer) {
    const reason = transfer.abortController.signal.reason;
    return reason instanceof Error ? reason : this.createAbortError('Transfer cancelled');
  }

  createAbortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  createTransferId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}