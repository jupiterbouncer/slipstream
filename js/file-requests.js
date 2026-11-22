// One request per channel. Approval only queues a local file; Phase 2 still asks for acceptance.
class FileRequests {
  constructor(peer, notify) {
    this.peer = peer;
    this.notify = notify;
    this.pending = null;
    this.seen = new Set();
  }

  begin(id, status) {
    this.pending = id;
    this.seen.add(id);
    this.timer = setTimeout(() => this.finish('File request expired. Try again.'), 60000);
    this.notify(status);
  }

  finish(status) {
    clearTimeout(this.timer);
    this.pending = null;
    this.notify(status);
  }

  request() {
    if (this.pending || this.peer.role !== 'joiner') return;
    const requestId = crypto.randomUUID();
    if (AppMessages.send(this.peer, 'file-request', { requestId })) this.begin(requestId, 'File requested');
    else this.notify('Could not request a file. Check the connection.');
  }

  receive(message) {
    const { requestId } = message;
    if (message.type === 'file-request' && this.peer.role === 'host') {
      if (this.seen.has(requestId)) return;
      if (this.pending) {
        this.seen.add(requestId);
        AppMessages.send(this.peer, 'file-request-result', { requestId, decision: 'declined' });
        return;
      }
      this.begin(requestId, 'File request received');
    } else if (message.type === 'file-request-result' && this.peer.role === 'joiner' && this.pending === requestId) {
      this.finish(message.decision === 'approved' ? 'Request approved. Waiting for the file offer.' : 'File request declined');
    }
  }

  respond(requestId, decision) {
    if (this.peer.role !== 'host' || !requestId || requestId !== this.pending) return false;
    const sent = AppMessages.send(this.peer, 'file-request-result', { requestId, decision });
    this.finish(sent ? 'File request ' + decision : 'Could not respond. Pair again to retry.');
    return sent;
  }

  close() {
    clearTimeout(this.timer);
    this.pending = null;
    this.seen.clear();
  }
}
