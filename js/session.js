// A new instance belongs to one open channel. Only terminal engine events change totals.
class SharingSession {
  constructor() {
    this.started = Date.now();
    this.activity = [];
    this.seen = new Set();
    this.verified = 0;
    this.bytes = 0;
    this.skipped = 0;
    this.transferStarted = null;
    this.transferEnded = null;
  }

  record(message, person) {
    this.activity.push({ time: Date.now(), message, person });
  }

  transfer(id, stage, name, bytes) {
    const key = id + '/' + stage;
    if (!id || this.seen.has(key)) return;
    this.seen.add(key);
    this.record(name + ' · ' + stage);
    if (stage === 'Offered') this.transferStarted = this.transferEnded = null;
    if (stage === 'Started') this.transferStarted = Date.now();
    if (['Verified', 'Rejected', 'Cancelled', 'Failed'].includes(stage)) this.transferEnded = Date.now();
    if (stage === 'Verified') {
      this.verified++;
      this.bytes += bytes;
    }
    if (stage === 'Rejected' || stage === 'Cancelled') this.skipped++;
  }
}
