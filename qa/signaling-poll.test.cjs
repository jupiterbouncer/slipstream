const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let timer;
  const errors = [];
  const scope = {
    AbortController,
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
