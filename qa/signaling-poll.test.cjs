const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(globals = {}) {
  let timer;
  const errors = [];
  const scope = {
    ...globals, AbortController,
    setTimeout(fn, delay) { assert.equal(timer, undefined); timer = { fn, delay }; return 1; },
    clearTimeout() { timer = undefined; },
  };
  const src = readFileSync(path.join(__dirname, '../js/webrtc.js'), 'utf8');
  const Peer = vm.runInNewContext(src + '\nSlipstreamPeer', scope);
  return {
    peer: new Peer({ onError: error => errors.push(error) }), errors,
    get delay() { return timer?.delay; },
    tick() { const { fn } = timer; timer = undefined; return fn(); },
  };
}

test('one pending request at a time, close aborts without rescheduling', async () => {
  const f = fixture();
  let finish, signal;
  f.peer.startPolling(s => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(f.delay, 2500);
  const tick = f.tick();
  assert.equal(f.delay, undefined);
  f.peer.close();
  assert.equal(signal.aborted, true);
  finish();
  await tick;
  assert.equal(f.delay, undefined);
  assert.deepEqual(f.errors, []);
});

test('temporary errors back off and recover, repeated failures stop', async () => {
  const f = fixture();
  let fail = true;
  f.peer.startPolling(async () => { if (fail) throw Object.assign(new Error(), { status: 503 }); });
  await f.tick();
  assert.equal(f.delay, 5000);
  fail = false;
  await f.tick();
  assert.equal(f.delay, 2500);
  fail = true;
  for (const delay of [5000, 10000, 20000, 30000, undefined]) {
    await f.tick();
    assert.equal(f.delay, delay);
  }
  assert.equal(f.errors.length, 1);
});

test('expired session and browser challenge stop polling immediately', async () => {
  for (const status of [200, 403, 404, 429]) {
    const f = fixture();
    f.peer.startPolling(async () => { throw Object.assign(new Error(), { status }); });
    await f.tick();
    assert.equal(f.delay, undefined);
    assert.equal(f.errors.length, 1);
  }
});

test('opening the data channel clears the pending poll', () => {
  const f = fixture();
  f.peer.startPolling(() => assert.fail('unexpected poll'));
  const channel = {};
  f.peer.setupDataChannel(channel);
  channel.onopen();
  assert.equal(f.delay, undefined);
});

test('transient candidate POST keeps the same candidate until acknowledged', async () => {
  const posted = [];
  const f = fixture({ Api: { async sendIceCandidate(code, role, candidate) {
    posted.push(candidate);
    if (posted.length === 1) throw Object.assign(new Error(), { status: 503 });
  } } });
  f.peer.pendingCandidates.push('first', 'second');
  let polls = 0;
  f.peer.startPolling(async () => { polls++; });
  await f.tick();
  assert.equal(f.delay, 5000);
  assert.equal(polls, 0);
  await f.tick();
  assert.deepEqual(posted, ['first', 'first', 'second']);
  assert.equal(polls, 1);
  f.peer.close();
});

test('remote cursor resumes at the first unapplied candidate and skips duplicate deliveries', async () => {
  const rows = [{ candidate: 'a' }, { candidate: 'b' }, { candidate: 'a' }];
  const cursors = [], applied = [];
  const f = fixture({
    Api: { getIceCandidates: async (code, role, after) => { cursors.push(after); return rows.slice(after); } },
    RTCIceCandidate: class { constructor(row) { this.candidate = row.candidate; } },
  });
  let failed = false;
  f.peer.pc = { remoteDescription: {}, async addIceCandidate(row) {
    if (row.candidate === 'b' && !failed) {
      failed = true;
      throw Object.assign(new Error(), { name: 'InvalidStateError' });
    }
    applied.push(row.candidate);
  } };
  f.peer.startPolling(signal => f.peer.pollCandidates('host', signal));
  await f.tick();
  await f.tick();
  assert.deepEqual(cursors, [0, 1]);
  assert.deepEqual(applied, ['a', 'b']);
  assert.equal(f.peer.candidateCursor, 3);
});

test('ICE connected keeps polling until the channel opens, ICE failed closes the peer once', async () => {
  let closes = 0;
  const f = fixture({ RTCPeerConnection: class {
    close() { closes++; }
  } });
  f.peer.role = 'joiner';
  await f.peer.start();
  const pc = f.peer.pc;
  pc.iceConnectionState = 'connected';
  pc.oniceconnectionstatechange();
  assert.equal(f.delay, 2500);
  pc.iceConnectionState = 'failed';
  pc.oniceconnectionstatechange();
  assert.equal(f.errors.length, 1);
  assert.equal(closes, 1);
  assert.equal(f.peer.pc, null);
  assert.equal(f.delay, undefined);
});
