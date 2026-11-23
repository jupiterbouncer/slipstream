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
  const src = readFileSync(path.join(__dirname, '../js/turn.js'), 'utf8') + '\n'
    + readFileSync(path.join(__dirname, '../js/webrtc.js'), 'utf8');
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

test('transient candidate POST keeps the same candidate and still reads remote signaling', async () => {
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
  assert.equal(polls, 1);
  await f.tick();
  assert.deepEqual(posted, ['first', 'first', 'second']);
  assert.equal(polls, 2);
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
  assert.equal(f.peer.snapshot().applied, 2);
  assert.equal(f.peer.snapshot().applyFailures, 1);
  assert.equal(f.peer.candidateCursor, 3);
});

test('host retries the identical offer, shares candidates during backoff, and aborts on close', async () => {
  const offers = [], posts = [];
  let signal;
  const f = fixture({ Api: {
    async sendOffer(code, offer, s) {
      signal = s;
      offers.push(offer);
      if (offers.length === 1) throw Object.assign(new Error(), { status: 503 });
    },
    async sendIceCandidate(code, role, c) { posts.push(c); },
  } });
  f.peer.pendingCandidates.push('candidate');
  const offer = { type: 'offer', sdp: 'same-generation' };
  f.peer.startHostPolling(offer);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(posts, ['candidate']);
  assert.equal(f.delay, 5000);
  await f.tick();
  assert.deepEqual(offers, [offer, offer]);
  assert.equal(f.peer.stage, 'Waiting for the other device…');
  f.peer.close();
  assert.equal(signal.aborted, true);
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

test('connection report retains sanitized candidate checks after close', async () => {
  const f = fixture();
  const report = new Map([
    ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: 'private-address' }],
    ['remote', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: 'public-address' }],
    ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote',
      state: 'in-progress', requestsSent: 12, responsesReceived: 0 }],
  ]);
  f.peer.pc = { getStats: async () => report, close() {} };
  f.peer.logCandidatePairs();
  await new Promise(resolve => setImmediate(resolve));
  f.peer.close();
  const entries = f.peer.constructor.diagnostics;
  const snapshot = entries.find(entry => entry.event === 'ICE candidate pairs');
  assert.equal(snapshot.pairs[0].requestsSent, 12);
  assert.equal(snapshot.pairs[0].responsesReceived, 0);
  assert.equal(snapshot.candidates.length, 2);
  assert.ok(!JSON.stringify(entries).includes('address'));
});

test('late stats from a closed peer cannot overwrite a new attempt report', async () => {
  const f = fixture();
  let complete;
  f.peer.pc = { getStats: () => new Promise(resolve => { complete = resolve; }), close() {} };
  f.peer.logCandidatePairs();
  f.peer.close();
  assert.ok(f.peer.constructor.diagnostics.some(e => e.event === 'connection closed'));
  assert.equal(f.peer.constructor.lastSnapshot.channelOpen, false);
  const next = new f.peer.constructor({ role: 'host' });
  next.log('new attempt');
  complete(new Map());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(next.constructor.diagnostics.length, 1);
  assert.equal(next.constructor.diagnostics[0].event, 'new attempt');
});
