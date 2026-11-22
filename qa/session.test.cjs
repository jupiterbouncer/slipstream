const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const name of ['session', 'application-messages', 'webrtc']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'));
}

test('activity order, verified totals, clearing and a fresh session', () => {
  const session = new SharingSession();
  for (const stage of ['Offered', 'Started', 'Verified', 'Verified']) session.transfer('a', stage, 'a.txt', 17);
  assert.deepEqual(session.activity.map(e => e.message), ['a.txt · Offered', 'a.txt · Started', 'a.txt · Verified']);
  session.activity.length = 0;
  session.transfer('a', 'Verified', 'a.txt', 17);
  session.transfer('b', 'Cancelled', 'b.txt');
  session.transfer('c', 'Rejected', 'c.txt');
  assert.deepEqual([session.verified, session.bytes, session.skipped], [1, 17, 2]);
  assert.equal(session.activity.length, 2);
  const fresh = new SharingSession();
  assert.deepEqual([fresh.activity.length, fresh.verified, fresh.bytes, fresh.seen.size], [0, 0, 0, 0]);
});

test('names are validated, routed only to the open session and never to file handlers', async () => {
  const names = [];
  const peer = new SlipstreamPeer({ role: 'host', onApplicationMessage: m => names.push(m.name),
    onControlMessage: assert.fail, onBinaryMessage: assert.fail });
  assert.equal(AppMessages.send(peer, 'device-name', { name: 'Desktop' }), false);
  const msg = { protocol: 'slipstream-app', version: 1, type: 'device-name', name: 'Laptop' };
  for (const change of [{}, { name: ' x' }, { name: 'x'.repeat(33) }, { type: 'other' }, { version: 2 }]) {
    await peer.handleIncomingData(JSON.stringify({ ...msg, ...change }));
  }
  peer.close();
  await peer.handleIncomingData(JSON.stringify(msg));
  assert.deepEqual(names, ['Laptop']);
  assert.equal(AppMessages.nickname('  My\u0007 laptop '), 'My laptop');
});
