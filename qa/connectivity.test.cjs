const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = ['turn.js', 'webrtc.js'].map(file =>
  readFileSync(path.join(__dirname, '../js', file), 'utf8')).join('\n');
const config = { domain: 'test.metered.live', apiKey: 'test-scoped-key' };
const servers = [{
  urls: ['turn:relay.example:80?transport=udp', 'turn:relay.example:80?transport=tcp', 'turns:relay.example:443?transport=tcp'],
  username: 'test-user', credential: 'test-password',
}];
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  const timers = new Map();
  const connections = [];
  const errors = [];
  let nextTimer = 0;
  const scope = {
    AbortController, URL,
    SLIPSTREAM_TURN_CONFIG: config,
    fetch: async () => ({ ok: true, json: async () => servers }),
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } },
    RTCPeerConnection: class {
      constructor(configuration) { this.configuration = configuration; connections.push(this); }
      close() { this.closed = true; }
    },
    ...overrides,
  };
  const Peer = vm.runInNewContext(source + '\nSlipstreamPeer', scope);
  const peer = new Peer({ role: 'joiner', onError: error => errors.push(error) });
  return {
    peer, connections, errors, timers,
    async fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'timer scheduled at ' + delay);
      timers.delete(entry[0]);
      await entry[1].fn();
      await flush();
    },
  };
}

test('TURN credentials are validated before construction and retain UDP/TCP/TLS plus Google STUN', async () => {
  let resolveFetch;
  const f = fixture({ fetch: (url, options) => {
    assert.equal(new URL(url).hostname, config.domain);
    assert.equal(new URL(url).searchParams.get('apiKey'), config.apiKey);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return new Promise(resolve => { resolveFetch = resolve; });
  } });
  const start = f.peer.start();
  assert.equal(f.connections.length, 0);
  resolveFetch({ ok: true, json: async () => servers });
  await start;
  const rtc = f.connections[0].configuration;
  assert.equal(rtc.iceTransportPolicy, 'all');
  assert.equal(rtc.iceServers.length, 3);
  assert.match(rtc.iceServers[0].urls, /stun\.l\.google\.com/);
  assert.deepEqual(Array.from(rtc.iceServers[2].urls), servers[0].urls);
  assert.equal(rtc.iceServers[2].credential, 'test-password');
  const diagnostics = JSON.stringify(f.peer.constructor.diagnostics);
  for (const value of ['test-scoped-key', 'test-password', 'test-user', 'relay.example']) {
    assert.ok(!diagnostics.includes(value));
  }
  f.peer.close();
});

test('empty or invalid config avoids provider requests and preserves STUN pairing', async () => {
  for (const value of [undefined, {}, { domain: '', apiKey: '' }, { ...config, domain: 'evil.example' },
    { ...config, domain: 'test.metered.live/path' }, { ...config, apiKey: '' }]) {
    const f = fixture({ SLIPSTREAM_TURN_CONFIG: value, fetch: () => assert.fail('unexpected fetch') });
    await f.peer.start();
    assert.equal(f.connections[0].configuration.iceServers.length, 2);
    f.peer.close();
  }
});

test('HTTP, network, HTML and malformed provider responses all fall back without exposing errors', async () => {
  const responses = [
    async () => { throw new Error('https://secret-key-in-url'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('secret HTML'); } }),
    ...[null, [], {}, [{ urls: 'https://evil.example' }], [{ urls: 'turn:relay.example' }],
      [{ ...servers[0], urls: 'turn:relay.example:99999' }],
      [{ ...servers[0], urls: 'turns:relay.example:443?transport=udp' }],
      [{ ...servers[0], urls: ['turn:relay.example', 'javascript:bad'] }],
    ].map(body => async () => ({ ok: true, json: async () => body })),
  ];
  for (const fetch of responses) {
    const f = fixture({ fetch });
    await f.peer.start();
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].configuration.iceServers.length, 2);
    assert.equal(f.errors.length, 0);
    assert.ok(!JSON.stringify(f.peer.constructor.diagnostics).includes('secret'));
    f.peer.close();
  }
});

test('four-second deadline covers a stalled fetch and stalled JSON body', async () => {
  for (const bodyStalls of [false, true]) {
    let signal;
    const f = fixture({ fetch: async (url, options) => {
      signal = options.signal;
      const pending = new Promise(() => {});
      return bodyStalls ? { ok: true, json: () => pending } : pending;
    } });
    const start = f.peer.start();
    await flush();
    await f.fire(4000);
    await start;
    assert.equal(signal.aborted, true);
    assert.equal(f.connections[0].configuration.iceServers.length, 2);
    assert.ok(f.peer.constructor.diagnostics.some(row => row.outcome === 'timeout'));
    f.peer.close();
  }
});

test('closing while credentials load aborts discovery and prevents late peer creation', async () => {
  let complete;
  const f = fixture({ fetch: () => new Promise(resolve => { complete = resolve; }) });
  const start = f.peer.start();
  f.peer.close();
  await start;
  complete({ ok: true, json: async () => servers });
  await flush();
  assert.equal(f.connections.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.errors.length, 0);
});

test('browser-rejected optional servers retry construction with STUN only', async () => {
  const configs = [];
  const f = fixture({ RTCPeerConnection: class {
    constructor(rtc) {
      configs.push(rtc);
      if (rtc.iceServers.length > 2) throw new Error('unsupported optional server');
    }
    close() {}
  } });
  await f.peer.start();
  assert.deepEqual(configs.map(rtc => rtc.iceServers.length), [3, 2]);
  assert.equal(f.errors.length, 0);
  f.peer.close();
});

test('permanent rejection is distinct from success and later valid candidates still apply once', async () => {
  const rows = [{ candidate: 'bad' }, { candidate: 'good' }, { candidate: 'bad' }, { candidate: 'good' }];
  const calls = [];
  const f = fixture({ Api: { getIceCandidates: async (code, role, cursor) => rows.slice(cursor) } });
  f.peer.pc = { remoteDescription: {}, addIceCandidate: async candidate => {
    calls.push(candidate.candidate);
    if (candidate.candidate === 'bad') throw Object.assign(new Error(), { name: 'OperationError' });
  }, close() {} };
  await f.peer.pollCandidates('host', new AbortController().signal);
  assert.deepEqual(calls, ['bad', 'good']);
  assert.equal(f.peer.processedCandidates.size, 1);
  assert.equal(f.peer.rejectedCandidates.size, 1);
  assert.equal(f.peer.applied, 1);
  assert.equal(f.peer.candidateCursor, 4);
  f.peer.close();
});

test('transient candidate rejection retries at most three times before continuing', async () => {
  const rows = [{ candidate: 'bad' }, { candidate: 'good' }];
  const calls = [];
  const f = fixture({ Api: { getIceCandidates: async (code, role, cursor) => rows.slice(cursor) } });
  f.peer.pc = { remoteDescription: {}, addIceCandidate: async candidate => {
    calls.push(candidate.candidate);
    if (candidate.candidate === 'bad') throw Object.assign(new Error(), { name: 'InvalidStateError' });
  }, close() {} };
  f.peer.startPolling(signal => f.peer.pollCandidates('host', signal));
  await f.fire(2500);
  await f.fire(5000);
  await f.fire(10000);
  assert.deepEqual(calls, ['bad', 'bad', 'bad', 'good']);
  assert.equal(f.peer.processedCandidates.size, 1);
  assert.equal(f.peer.rejectedCandidates.size, 1);
  assert.equal(f.errors.length, 0);
  f.peer.close();
});

test('selected transport identifies direct and relayed routes despite other nominated pairs', async () => {
  for (const type of ['host', 'srflx', 'prflx', 'relay']) {
    const f = fixture();
    const stats = new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
      ['local', { type: 'local-candidate', candidateType: type, address: 'private-address' }],
      ['remote', { type: 'remote-candidate', candidateType: 'host' }],
      ['other', { type: 'candidate-pair', nominated: true, state: 'succeeded' }],
      ['selected', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ]);
    f.peer.pc = { getStats: async () => stats, close() {} };
    f.peer.logCandidatePairs();
    await flush();
    assert.equal(f.peer.snapshot().selectedRoute.route, type === 'relay' ? 'relayed' : 'direct');
    assert.equal(f.peer.snapshot().selectedRoute.local, type);
    assert.equal(f.peer.snapshot().selectedRoute.kind, { host: 'local', srflx: 'nat', prflx: 'nat', relay: 'relay' }[type]);
    assert.ok(!JSON.stringify(f.peer.constructor.diagnostics).includes('private-address'));
    f.peer.close();
  }
});

test('Safari ICE transport fallback reports selected route and otherwise leaves selection unknown', async () => {
  const f = fixture();
  f.peer.pc = { getStats: async () => new Map(), close() {},
    sctp: { transport: { iceTransport: { getSelectedCandidatePair: () => ({ local: { type: 'host' }, remote: { type: 'relay' } }) } } } };
  f.peer.logCandidatePairs();
  await flush();
  assert.equal(f.peer.selectedRoute.route, 'relayed');
  f.peer.pc.sctp = undefined;
  f.peer.logCandidatePairs();
  await flush();
  assert.equal(f.peer.selectedRoute.route, 'unknown');
  f.peer.close();
});

test('temporary disconnect recovers within grace period and sustained disconnect fails once', async () => {
  const f = fixture({ SLIPSTREAM_TURN_CONFIG: {} });
  await f.peer.start();
  f.peer.dataChannel = { readyState: 'open', close() {} };
  f.peer.stopPolling();
  const pc = f.peer.pc;
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  assert.equal(f.peer.stage, 'Reconnecting…');
  assert.equal(f.peer.isChannelOpen(), true);
  pc.iceConnectionState = 'checking';
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  assert.equal(f.timers.size, 1);
  pc.iceConnectionState = 'completed';
  pc.oniceconnectionstatechange();
  assert.equal(f.peer.stage, 'Connected');
  assert.equal(f.timers.size, 0);
  assert.equal(f.peer.isClosed, false);
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange();
  pc.iceConnectionState = 'disconnected';
  pc.oniceconnectionstatechange();
  assert.equal(f.timers.size, 1);
  await f.fire(30000);
  assert.equal(f.peer.constructor.lastSnapshot.reason, 'recovery-timeout');
  assert.deepEqual(Array.from(f.peer.events.filter(e => e.event === 'connection recovery ended'), e => e.outcome), ['recovered', 'recovery-timeout']);
  assert.equal(f.peer.isClosed, true);
  assert.equal(f.errors.length, 1);
  f.peer.connectionFailed();
  assert.equal(f.errors.length, 1);
});

test('bounded post-open signaling exchanges a late mDNS candidate; expired sessions preserve the channel', async () => {
  for (const expired of [true, false]) {
    const posted = [];
    const f = fixture({ SLIPSTREAM_TURN_CONFIG: {}, Api: {
      async sendIceCandidate(code, role, candidate) { posted.push(candidate); },
      async getIceCandidates() {
        if (expired) throw Object.assign(new Error(), { status: 404 });
        return [{ candidate: 'remote.local' }];
      },
    } });
    await f.peer.start();
    const pc = f.peer.pc;
    pc.remoteDescription = {};
    pc.addIceCandidate = async c => assert.equal(c.candidate, 'remote.local');
    const channel = { readyState: 'open', close() {} };
    pc.ondatachannel({ channel });
    channel.onopen();
    pc.onicecandidate({ candidate: { type: 'host', address: 'private.local',
      toJSON: () => ({ candidate: 'local.local' }) } });
    await f.fire(2500);
    assert.equal(posted.length, expired ? 0 : 1);
    assert.equal(f.peer.applied, expired ? 0 : 1);
    if (!expired) await f.fire(10000);
    assert.equal(f.timers.size, 0);
    assert.equal(f.peer.isChannelOpen(), true);
    assert.equal(f.errors.length, 0);
    assert.ok(!JSON.stringify(f.peer.events).includes('private.local'));
    f.peer.close();
  }
});

test('stats requested before close reach the closed attempt even after native teardown', async () => {
  const f = fixture();
  let resolve;
  f.peer.pc = { getStats: () => new Promise(r => { resolve = r; }), close() {} };
  f.peer.connectionFailed(undefined, 'ice-failed');
  resolve(new Map([
    ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { type: 'candidate-pair', localCandidateId: 'l' }],
    ['l', { type: 'local-candidate', candidateType: 'relay' }],
  ]));
  await flush();
  assert.equal(f.peer.constructor.lastSnapshot.selectedRoute.route, 'relayed');
  assert.equal(f.peer.events.at(-1).pairs[0].selected, true);
});
