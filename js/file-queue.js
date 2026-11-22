class FileQueue {
  constructor(startFile, changed) {
    this.startFile = startFile;
    this.changed = changed;
    this.pending = [];
    this.running = false;
  }

  add(files) {
    const oversized = [];
    for (const file of files) {
      if (file.size > TransferProtocol.maxFileSize) oversized.push(file.name);
      else this.pending.push(file);
    }
    this.changed();
    return oversized;
  }

  remove(index) {
    this.pending.splice(index, 1);
    this.changed();
  }

  clear() {
    this.pending.length = 0;
    this.changed();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const file = this.pending.shift();
        this.changed();
        // start() settles after the single-file engine has released its active transfer.
        // Rejection and cancellation skip one file. A failure leaves the rest for a manual retry.
        const result = await this.startFile(file);
        if (result.state === 'failed') break;
      }
    } finally {
      this.running = false;
      this.changed();
    }
  }
}
