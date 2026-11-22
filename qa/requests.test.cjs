const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const name of ['transfer-protocol', 'application-messages', 'file-requests']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'));
}
function side(role) {
  const wire = [], events = [];
  const peer = { role, isChannelOpen: () => true, send: raw => wire.push(JSON.parse(raw)) };
  return { wire, events, peer, requests: new FileRequests(peer, e => events.push(e)) };
}

test('request, duplicate, decline, stale response and approval', t => {
  const sender = side('host'), receiver = side('joiner');
  t.after(() => { sender.requests.close(); receiver.requests.close(); });
  for (const decision of ['declined', 'approved']) {
    receiver.requests.request();
    receiver.requests.request();
    assert.equal(receiver.wire.length, 1);
    const message = receiver.wire.pop();
    sender.requests.receive(message);
    sender.requests.receive(message);
    const otherId = crypto.randomUUID();
    sender.requests.receive({ ...message, requestId: otherId });
    receiver.requests.receive(sender.wire.pop());
    assert.equal(receiver.requests.pending, message.requestId);
    assert.equal(sender.requests.respond(otherId, decision), false);
    assert.equal(sender.requests.respond(message.requestId, decision), true);
    receiver.requests.receive(sender.wire.pop());
    assert.equal(receiver.requests.pending, null);
    sender.requests.receive(message);
    assert.equal(sender.requests.pending, null);
  }
  assert.equal(sender.events.filter(e => e === 'File request received').length, 2);
});

test('wrong roles, invalid fields and closed channels cannot request a file', () => {
  const { requests, peer, wire } = side('joiner');
  const msg = { protocol: 'slipstream-app', version: 1, type: 'file-request', requestId: crypto.randomUUID() };
  assert.equal(AppMessages.valid(msg, 'host'), false);
  assert.equal(AppMessages.valid({ ...msg, requestId: 'bad' }, 'joiner'), false);
  const result = { ...msg, type: 'file-request-result', decision: 'approved' };
  assert.equal(AppMessages.valid(result, 'joiner'), false);
  assert.equal(AppMessages.valid({ ...result, decision: true }, 'host'), false);
  peer.isChannelOpen = () => false;
  requests.request();
  assert.equal(wire.length, 0);
  assert.equal(requests.pending, null);
});
