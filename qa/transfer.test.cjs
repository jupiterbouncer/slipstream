// Run from any directory with Node 22+: node --test qa/transfer.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
for (const name of ['webrtc', 'transfer-protocol', 'file-sender', 'file-receiver', 'file-queue']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js', name + '.js'), 'utf8'), { filename: name });
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for protocol state');
    await tick();
  }
}

function fixture(options = {}) {
  const messages = [], chunks = [], states = [[], []], progress = [[], []], completed = [[], []], errors = [];
  const peers = [0, 1].map(() => new SlipstreamPeer({}));
  const channels = peers.map((peer, side) => {
    const ch = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0 });
    ch.send = data => {
      if (ch.readyState !== 'open') throw Error('Closed');
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        messages.push(message);
        if (message.type === options.drop) return;
      } else {
        chunks.push(data.byteLength);
        ch.bufferedAmount += data.byteLength;
        if (options.corrupt) new Uint8Array(data)[0] ^= 1;
      }
      queueMicrotask(() => {
        if (ch.readyState === 'open') peers[1 - side].dataChannel.onmessage({ data });
      });
    };
    peer.dataChannel = ch;
    peer.setupDataChannel(ch);
    return ch;
  });
  const callbacks = side => ({
    peer: peers[side], onStateChange: state => states[side].push(state),
    onProgress: event => progress[side].push(event.bytesReceived),
    onComplete: result => completed[side].push(result), onError: error => errors.push(error.message),
  });
  const sender = new SlipstreamFileSender({ ...callbacks(0), timeoutMs: options.timeoutMs ?? 5000 });
  const receiver = new SlipstreamFileReceiver({ ...callbacks(1), maxFileSize: options.maxFileSize });
  peers[0].onControlMessage = m => sender.handleControlMessage(m);
  peers[1].onControlMessage = m => receiver.handleControlMessage(m);
  peers[1].onBinaryMessage = b => receiver.handleBinaryChunk(b);
  peers[0].onChannelClose = () => sender.channelClosed();
  peers[1].onChannelClose = () => receiver.channelClosed();
  function drain() {
    channels[0].bufferedAmount = 0;
    channels[0].dispatchEvent(new Event('bufferedamountlow'));
  }
  function close() {
    for (const ch of channels) { ch.readyState = 'closed'; ch.onclose(); }
  }
  async function offer(file) {
    const done = sender.start(file);
    await until(() => receiver.active?.state === 'awaiting-decision');
    return { done };
  }
  return { sender, receiver, channels, peers, messages, chunks, states, progress, completed, errors, offer, drain, close };
}

function file(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return new File([bytes], 'Résumé & notes.bin', { lastModified: 123 });
}

for (const size of [0, 1, 16383, 16384, 16385, 3 * 1024 * 1024 + 7]) {
  test('verify and acknowledge ' + size + ' bytes', async () => {
    const f = fixture(), original = file(size);
    const { done } = await f.offer(original);
    assert.equal(f.chunks.length, 0);
    const drainTimer = setInterval(f.drain, 3);
    try { f.receiver.accept(); assert.equal((await done).state, 'completed'); }
    finally { clearInterval(drainTimer); }
    const expected = Buffer.from(await original.arrayBuffer());
    assert.deepEqual(Buffer.from(await f.completed[1][0].blob.arrayBuffer()), expected);
    assert.equal(f.completed[0][0].sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal(f.messages[0].file.mimeType, 'application/octet-stream');
    assert.equal(f.messages.at(-1).type, 'file-complete-ack');
    assert.deepEqual(f.progress[0], f.messages.filter(m => m.type === 'file-progress').map(m => m.bytesReceived));
    assert.equal(f.progress[0].at(-1), size);
    assert.equal(f.chunks.length, Math.ceil(size / 16384));
    assert.ok(f.chunks.every((n, i) => n === Math.min(16384, size - i * 16384)));
    if (size > 1024 * 1024) assert.ok(f.progress[0].length < f.chunks.length);
    assert.equal(f.errors.length, 0);
  });
}

test('decline followed by a second transfer on the same channel', async () => {
  const f = fixture();
  const first = await f.offer(file(1)); f.receiver.reject();
  assert.equal((await first.done).state, 'rejected'); assert.equal(f.chunks.length, 0);
  for (let i = 0; i < 2; i++) {
    const next = await f.offer(file(12)); f.receiver.accept(); assert.equal((await next.done).state, 'completed');
  }
  assert.equal(new Set(f.messages.filter(m => m.type === 'file-offer').map(m => m.transferId)).size, 3);
});

for (const action of ['sender cancel', 'receiver cancel', 'close', 'resume']) {
  test(action + ' while waiting for back-pressure', async () => {
    const f = fixture();
    const { done } = await f.offer(file(2 * 1024 * 1024)); f.receiver.accept();
    await until(() => f.channels[0].bufferedAmount > 1024 * 1024);
    await tick();
    const queued = f.chunks.length;
    assert.equal(queued, 65);
    assert.equal(f.channels[0].bufferedAmountLowThreshold, 256 * 1024);
    if (action === 'close') f.close();
    else if (action === 'resume') f.drain();
    else (action === 'sender cancel' ? f.sender : f.receiver).cancel();
    assert.equal((await done).state, { close: 'failed', resume: 'completed' }[action] || 'cancelled');
    await tick(); assert.equal(f.receiver.active, null);
    assert.equal(f.channels[0].bufferedAmountLowThreshold, 0);
    if (action !== 'resume') {
      assert.equal(f.chunks.length, queued); assert.deepEqual(f.completed, [[], []]);
      if (action !== 'close') assert.equal(f.messages.at(-1).type, 'file-cancel-ack');
    }
  });
}

test('corrupted bytes fail hashing and yield no download or ACK', async () => {
  const f = fixture({ corrupt: true }); const { done } = await f.offer(file(1)); f.receiver.accept();
  assert.equal((await done).state, 'failed'); assert.equal(f.messages.at(-1).code, 'HASH_MISMATCH');
  assert.deepEqual(f.completed, [[], []]);
});

test('stale ID, malformed ID, duplicate offer, accept, completion and ACK', async () => {
  const f = fixture(); const { done } = await f.offer(file(1));
  const offer = f.messages[0]; f.receiver.handleControlMessage(offer);
  f.sender.handleControlMessage({ ...offer, type: 'file-accept', transferId: crypto.randomUUID() });
  f.receiver.handleControlMessage({ ...offer, type: 'file-start', transferId: 'invalid' });
  assert.equal(f.chunks.length, 0); assert.equal(f.states[1].length, 1);
  f.receiver.accept(); await until(() => f.messages.some(m => m.type === 'file-start'));
  f.sender.handleControlMessage({ ...offer, type: 'file-accept' });
  await done;
  for (const m of f.messages.slice()) { f.sender.handleControlMessage(m); f.receiver.handleControlMessage(m); }
  assert.deepEqual(f.completed.map(a => a.length), [1, 1]); assert.equal(f.receiver.active, null);
});

test('invalid metadata and size guardrails', async () => {
  const f = fixture({ maxFileSize: 8 }); const done = f.sender.start(file(9));
  assert.equal((await done).reason, 'file-too-large');
  const offer = f.messages[0];
  for (const fields of [{name:''}, {mimeType:23}, {size:-1}, {totalChunks:7}, {chunkSize:100}, {hash:{}}, {lastModified:null}]) {
    f.receiver.handleControlMessage({ ...offer, transferId:crypto.randomUUID(), file:{...offer.file,...fields} });
    assert.equal(f.messages.at(-1).reason,'invalid-metadata'); assert.equal(f.receiver.active,null);
  }
  const large = file(1); Object.defineProperty(large,'size',{ value:100*1024*1024+1 });
  await assert.rejects(f.sender.start(large), /size limit/);
});

for (const drop of ['file-complete-ack', 'file-accept']) {
  test('60-second deadline (short test clock) when missing '+drop, async () => {
    const f=fixture({drop,timeoutMs:120}); const {done}=await f.offer(file(1)); f.receiver.accept();
    assert.equal((await done).state,'failed'); assert.equal(f.completed[0].length,0);
    assert.ok(f.messages.some(m=>m.type==='file-cancel' && m.reason==='timeout'));
  });
}

test('premature binary, short chunk and bad completion counts', async () => {
  for (const mode of ['early','length','counts']) {
    const f=fixture(), {done}=await f.offer(file(16385));
    if(mode==='early') f.receiver.handleBinaryChunk(new ArrayBuffer(1));
    else {
      f.receiver.enter('ready'); f.receiver.handleControlMessage({...f.messages[0],type:'file-start'});
      if(mode==='length') f.receiver.handleBinaryChunk(new ArrayBuffer(2));
      else f.receiver.handleControlMessage({...f.messages[0],type:'file-complete',bytesSent:0,chunksSent:0});
    }
    assert.equal((await done).state,'failed'); assert.deepEqual(f.completed,[[],[]]);
  }
});

test('mixed Blob, binary and control remain ordered; chat arrives once', async () => {
  const f=fixture(), seen=[], receiver=f.peers[1];
  receiver.onBinaryMessage=b=>seen.push(new Uint8Array(b)[0]);
  receiver.onControlMessage=m=>seen.push(m.type);
  receiver.onChannelMessage=s=>seen.push(JSON.parse(s).message);
  for(const data of [new Blob([Uint8Array.of(1)]), Uint8Array.of(2).buffer, JSON.stringify({protocol:'slipstream',version:1,transferId:crypto.randomUUID(),type:'file-complete'}), '{"type":"text","message":"hello"}','bad JSON']) {
    receiver.dataChannel.onmessage({data});
  }
  await receiver.receiveQueue; assert.deepEqual(seen,[1,2,'file-complete','hello']);
});

test('cancelling a pending file read settles immediately and prevents a late offer', async () => {
  const f = fixture();
  const original = file(1);
  let finishRead;
  original.arrayBuffer = () => new Promise(resolve => { finishRead = resolve; });
  const done = f.sender.start(original);
  f.sender.cancel();
  assert.equal((await done).state, 'cancelled');
  finishRead(new ArrayBuffer(1));
  await tick();
  assert.deepEqual(f.messages, []);
});

test('invalid completion acknowledgments cannot report success', async () => {
  for (const invalid of [{ status: 'sent' }, { bytesReceived: 7 }, { sha256: '0'.repeat(64) }]) {
    const f = fixture({ drop: 'file-complete-ack' });
    const { done } = await f.offer(file(8));
    f.receiver.accept();
    await until(() => f.messages.at(-1)?.type === 'file-complete-ack');
    f.sender.handleControlMessage({ ...f.messages.at(-1), ...invalid });
    assert.equal((await done).state, 'failed');
    assert.equal(f.completed[0].length, 0);
  }
});

test('busy receiver and unsupported version preserve the active offer', async () => {
  const f = fixture();
  const { done } = await f.offer(file(1));
  const original = f.messages[0];
  f.receiver.handleControlMessage({ ...original, transferId: crypto.randomUUID() });
  assert.equal(f.messages.at(-1).reason, 'receiver-busy');
  f.receiver.handleControlMessage({ ...original, transferId: crypto.randomUUID(), version: 2 });
  assert.equal(f.messages.at(-1).code, 'UNSUPPORTED_VERSION');
  assert.equal(f.receiver.active.id, original.transferId);
  f.sender.cancel();
  assert.equal((await done).state, 'cancelled');
});

test('queue waits for engine cleanup and skips rejected and cancelled files', async () => {
  const f = fixture();
  let starts = 0;
  const queue = new FileQueue(file => {
    assert.equal(f.sender.active, null);
    starts++;
    return f.sender.start(file);
  }, () => {});
  queue.add([file(5), file(6), file(7), file(8)]);
  const done = queue.run();
  await queue.run();
  for (const [size, decide] of [[5, 'reject'], [6, 'cancel'], [7, 'accept'], [8, 'accept']]) {
    await until(() => f.receiver.active?.file.size === size);
    assert.equal(f.receiver.active.state, 'awaiting-decision');
    f.receiver[decide]();
  }
  await done;
  assert.equal(starts, 4);
  assert.deepEqual(f.completed[0].map(result => result.bytesReceived), [7, 8]);
  assert.equal(f.sender.active, null);
});

test('clear pending preserves the active file until receiver verification', async () => {
  const f = fixture({ drop: 'file-complete-ack' });
  const queue = new FileQueue(file => f.sender.start(file), () => {});
  queue.add([file(1), file(2)]);
  const done = queue.run();
  await until(() => f.receiver.active);
  queue.clear();
  f.receiver.accept();
  await until(() => f.completed[1].length);
  assert.equal(queue.running, true);
  const ack = f.messages.find(m => m.type === 'file-complete-ack');
  f.sender.handleControlMessage(ack);
  f.sender.handleControlMessage(ack);
  await done;
  assert.equal(queue.running, false);
  assert.equal(f.completed[0].length, 1);
  assert.equal(f.messages.filter(m => m.type === 'file-offer').length, 1);
});

test('oversize, removal and failed starts leave remaining files reviewable', async () => {
  const queue = new FileQueue(async () => ({ state: 'failed' }), () => {});
  assert.deepEqual(queue.add([{ size: 2**30, name: 'big' }, file(1), file(2), file(3)]), ['big']);
  queue.remove(1);
  await queue.run();
  assert.deepEqual(queue.pending.map(file => file.size), [3]);
});
