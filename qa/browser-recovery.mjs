import { checkSharing } from './browser-sharing.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

// Run against the packaged frontend served by local PHP/MySQL on port 8137.
// The test creates and deletes its own sessions and uses temporary Chrome profiles.
const directOnly = process.argv.includes('--stun-only');
const origin = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'http://127.0.0.1:8137';
assert.ok(['http://127.0.0.1:8137'].includes(origin));
const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const temp = await mkdtemp(path.join(tmpdir(), 'slipstream-chrome-'));
const processes = [], sockets = [], closeBrowsers = [];
async function waitFor(label, check) {
  const deadline = Date.now() + 45000;
  do {
    const value = await check();
    if (value) return value;
    await pause(125);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

async function checkDirectPeers(sender, receiver, stage) {
  for (const [role, tab] of [['host', sender], ['joiner', receiver]]) {
    const sample = await tab.evaluate(`(async () => {
      const cfg = testPeer.getConfiguration();
      const stats = await testPeer.getStats();
      const transport = [...stats.values()].find(row => row.type === 'transport' && row.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId);
      const events = SlipstreamPeer.diagnostics;
      const count = name => events.filter(entry => entry.event === name).length;
      return {
        all: cfg.iceTransportPolicy === 'all', stun: cfg.iceServers.flatMap(s => s.urls),
        disabled: events.some(e => e.event === 'TURN configuration' && e.outcome === 'disabled'),
        open: events.some(e => e.event === 'data channel open') && testPeer.connectionState === 'connected',
        local: stats.get(pair?.localCandidateId)?.candidateType, remote: stats.get(pair?.remoteCandidateId)?.candidateType,
        state: pair?.state, responses: pair?.responsesReceived, bytes: pair?.bytesReceived,
        gathered: count('local ICE candidate gathered'), posted: count('local ICE candidate acknowledged'),
        applied: count('remote ICE candidate accepted'),
      };
    })()`);
    assert.ok(sample.all && sample.disabled && sample.open);
    assert.deepEqual(sample.stun, ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']);
    assert.equal(sample.state, 'succeeded');
    for (const type of [sample.local, sample.remote]) assert.ok(['host', 'srflx', 'prflx'].includes(type));
    console.log(stage, role, JSON.stringify(sample));
  }
}

async function browser(role) {
  const profile = path.join(temp, role);
  const process = spawn(chrome, ['--headless=new', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  processes.push(process);
  let launchError;
  process.on('error', error => { launchError = error; });
  const port = await waitFor(role + ' Chrome', async () => {
    if (launchError) throw launchError;
    const file = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    return file.split(/\r?\n/)[0];
  });
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let id = 0;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Page.javascriptDialogOpening') { console.error(role, message.params.message); command('Page.handleJavaScriptDialog', {accept:true}).catch(()=>{}); }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result);
  };
  function command(method, params = {}) {
    const current = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(current);
        reject(new Error(role + ' browser command timed out: ' + method));
      }, 20000);
      pending.set(current, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || expression);
    return result.result.value;
  }
  async function click(selector) {
    const point = await waitFor(selector, () => evaluate(`(() => {
      if (document.readyState !== 'complete') return;
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e || !e.getClientRects().length || e.disabled) return;
      e.scrollIntoView({block:'center'});
      const r = e.getBoundingClientRect();
      const point = { x: r.x + r.width/2, y: r.y + r.height/2 };
      if (e.contains(document.elementFromPoint(point.x, point.y))) return point;
    })()`)).catch(async error => {
      const screen = await evaluate("document.querySelector('.screen-view.active')?.id");
      throw new Error(error.message + ' on ' + screen);
    });
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  }
  async function selectFiles(selector, files) {
    // A fresh document query avoids retaining stale DevTools node IDs across UI changes.
    const { root } = await command('DOM.getDocument');
    const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector });
    await command('DOM.setFileInputFiles', { nodeId, files });
  }
  await command('Page.enable');
  closeBrowsers.push(() => command('Browser.close'));
  console.log(role + ' Chrome ready');
  return { command, evaluate, click, selectFiles };
}

try {
  const [sender, receiver] = await Promise.all([browser('sender'), browser('receiver')]);
  if (directOnly) {
    // Scope the override to these disposable profiles, including QR navigation and retries.
    for (const tab of [sender, receiver]) await tab.command('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(window, 'SLIPSTREAM_TURN_CONFIG', { get: () => ({}), set() {} });",
    });
  }
  await sender.command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.RTCPeerConnection = class extends RTCPeerConnection {
      constructor(...args) {
        super(...args);
        window.testPeer = this;
        window.appliedCandidates = { accepted: 0, failed: 0 };
      }
      async addIceCandidate(candidate) {
        try {
          await super.addIceCandidate(candidate);
          window.appliedCandidates.accepted++;
        } catch (error) {
          window.appliedCandidates.failed++;
          throw error;
        }
      }
    };` });
  await receiver.command('Page.addScriptToEvaluateOnNewDocument',{source:'const NativePeer=RTCPeerConnection; window.RTCPeerConnection=class extends NativePeer { constructor(...args){super(...args);window.testPeer=this;} };'});
  await receiver.command('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  const downloadPath = path.join(temp, 'downloads');
  await mkdir(downloadPath);
  await receiver.command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await sender.command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await sender.command('Page.navigate', { url: origin });
  console.log('Sender navigation complete');
  await waitFor('sender UI', () => sender.evaluate("document.readyState === 'complete' && typeof Api === 'object'"));
  // Expire a real test session while its host is waiting.
  await sender.click('#btn-start-send');
  const codeOf = tab => waitFor('pairing code', async () => {
    const code = await tab.evaluate("document.querySelector('#host-code-text')?.textContent");
    return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code) && code;
  });
  const replaced = await codeOf(sender);
  await sender.click('#new-code');
  await waitFor('regenerated code', () => sender.evaluate("document.querySelector('#new-code').disabled === false && document.querySelector('#host-code-text').textContent !== " + JSON.stringify(replaced)));
  const first = await codeOf(sender);
  assert.equal(await sender.evaluate("Api.getSession(" + JSON.stringify(replaced) + ").then(() => 200, e => e.status)"), 404);
  await sender.evaluate("Api.deleteSession("+JSON.stringify(first)+")");
  const failure = tab => waitFor('connection failure', () => tab.evaluate("!!document.querySelector('#screen-failed.active')"));
  await failure(sender);
  const gated = tab => tab.evaluate("!document.querySelector('#screen-connected.active')");
  assert.ok(await gated(sender));
  await sender.click('#retry-pairing');
  const second = await codeOf(sender);
  assert.notEqual(second,first); assert.ok(await gated(sender));
  await receiver.command('Page.navigate',{url:origin});
  await waitFor('receiver app',()=>receiver.evaluate("document.readyState === 'complete' && typeof Api === 'object'"));
  await receiver.evaluate("window.realAnswer = Api.sendAnswer; Api.sendAnswer = async () => { throw Object.assign(new Error('Injected rejection'), {status:403}); }");
  await receiver.click('#btn-start-receive');
  await receiver.evaluate("document.querySelector('#join-code-input').value="+JSON.stringify(second));
  await receiver.click('#btn-submit-join');
  await failure(receiver);
  await receiver.click('#retry-pairing');
  assert.ok(await receiver.evaluate("!!document.querySelector('#screen-join.active') && !document.querySelector('#join-code-input').value"));
  assert.ok(await gated(receiver)); await failure(sender);
  await sender.evaluate("window.postAttempts=0;const sendCandidate=Api.sendIceCandidate;Api.sendIceCandidate=(...args)=>{if(++postAttempts===1) return Promise.reject(Object.assign(new Error('Injected transient error'),{status:503}));return sendCandidate(...args)}");
  await sender.click('#retry-pairing');
  console.log('Both roles recovered from pre-open failures with chat gated.');
  const code = await waitFor('pairing code', async () => {
    const value = await sender.evaluate("document.querySelector('#host-code-text')?.textContent");
    return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(value) && value;
  });
  await receiver.command('Page.navigate', { url: origin + '/?join=' + code });
  for (const browser of [sender, receiver])
    await waitFor('open data channel', () => browser.evaluate("!!document.querySelector('#screen-connected.active')"));
  assert.ok(await sender.evaluate('postAttempts>=2'));
  for (const tab of [sender, receiver]) await tab.click('#tab-messages');
  await sender.evaluate("document.querySelector('#share-text').value='recovered chat'; document.querySelector('#send-text').click()");
  await waitFor('chat delivery',()=>receiver.evaluate("document.querySelector('#received-text').textContent.includes('recovered chat')"));
  await receiver.click('#share-text');
  await receiver.evaluate("document.querySelector('#share-text').value='receiver reply'");
  await receiver.click('#send-text');
  await waitFor('receiver reply',()=>sender.evaluate("document.querySelector('#received-text').textContent.includes('receiver reply')"));
  await receiver.evaluate(`window.receivedProgress=[];const originalChunk=SlipstreamFileReceiver.prototype.handleBinaryChunk;
    SlipstreamFileReceiver.prototype.handleBinaryChunk=function(chunk) {
      originalChunk.call(this,chunk);
      const fill=document.querySelector('#transfer-trail-fill');
      receivedProgress.push({text:document.querySelector('#transfer-percentage-text').textContent,variable:fill.style.getPropertyValue('--trail-progress')});
    };`);
  console.log('Transient ICE POST recovery and bidirectional chat passed.');
  await sender.click('#tab-files');
  const name = 'slipstream-test.bin', original = randomBytes(1024 * 1024 + 1);
  const fixture = path.join(temp, name);
  await writeFile(fixture, original);
  await sender.selectFiles('#file-input', [fixture]);
  if (directOnly) await checkDirectPeers(sender, receiver, 'before offer');
  await sender.click('#btn-send-file');
  await waitFor('offer',()=>receiver.evaluate("!!document.querySelector('#btn-accept-transfer').getClientRects().length"));
  await receiver.click('#tab-messages');
  await receiver.evaluate("document.querySelector('#share-text').value='chat during offer'");
  await receiver.click('#send-text');
  await waitFor('chat during offer',()=>sender.evaluate("document.querySelector('#received-text').textContent.includes('chat during offer')"));
  await receiver.click('#tab-files');
  await receiver.click('#btn-accept-transfer');
  for (const browser of [receiver, sender])
    await waitFor('verified completion', () => browser.evaluate("!!document.querySelector('#transfer-state-pill.completed')"));
  assert.ok(await receiver.evaluate("receivedProgress.some(p=>parseInt(p.text)>0 && parseInt(p.text)<100) && receivedProgress.every(p=>p.text===p.variable)"));
  for (const width of [320,360,375,390,430,768,1280]) {
    await receiver.command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
    for (const percent of [25,75]) {
      const dimensions=await receiver.evaluate(`(()=>{
        const fill=document.querySelector('#transfer-trail-fill');
        fill.style.transition='none';
        fill.style.setProperty('--trail-progress','${percent}%');
        const f=fill.getBoundingClientRect(),track=fill.parentElement.getBoundingClientRect();
        const vertical=track.height>track.width;
        const label=document.querySelector('#transfer-percentage-text');
        const range=document.createRange();
        range.selectNodeContents(label);
        const strip=document.querySelector('.security-strip').getBoundingClientRect();
        const copy=document.querySelector('#security-copy');
        const shield=document.querySelector('.security-strip svg').getBoundingClientRect();
        const centered=Math.abs((shield.left + copy.getBoundingClientRect().right) / 2 - (strip.left + strip.width / 2)) < 2;
        return {ratio:vertical ? f.height/track.height : f.width/track.width, overflow:document.documentElement.scrollWidth>innerWidth,
          percentLines:range.getClientRects().length, centered};
      })()`);
      assert.ok(Math.abs(dimensions.ratio-percent/100)<0.02, JSON.stringify({width,percent,dimensions}));
      assert.equal(dimensions.overflow,false,'horizontal overflow at '+width);
      assert.equal(dimensions.percentLines,1,'percentage fits on one line at '+width);
      assert.ok(dimensions.centered,'security strip centered at '+width);
      assert.ok(await receiver.evaluate(`(() => {
        const copy = document.querySelector('#security-copy');
        const actual = copy.textContent;
        const range = document.createRange();
        try {
          for (const text of ['Direct · DTLS encrypted · Server pairs devices', 'Via TURN · DTLS encrypted · Server pairs devices', 'DTLS encrypted · Server pairs devices']) {
            copy.textContent = text;
            range.selectNodeContents(copy);
            if (range.getClientRects().length !== 1) return false;
          }
          return true;
        } finally { copy.textContent = actual; }
      })()`), 'single-line security strip at '+width);
    }
  }
  await receiver.click('#tab-messages');
  await receiver.evaluate("document.querySelector('#transfer-trail-fill').style.setProperty('--trail-progress','100%');document.querySelector('#share-text').value='chat after completion'");
  await receiver.click('#send-text');
  await waitFor('chat after completion',()=>sender.evaluate("document.querySelector('#received-text').textContent.includes('chat after completion')"));
  console.log('Chat before/during offers and after completion; actual receiver progress and seven viewport layouts passed.');
  await receiver.click('#tab-files');
  await receiver.click('#btn-download-file');
  const bytes = await waitFor('download', () => readFile(path.join(downloadPath, name)).catch(() => null));
  assert.deepEqual(bytes, original);
  if (directOnly) await checkDirectPeers(sender, receiver, 'after verified download');
  console.log(origin, bytes.length, 'bytes verified and downloaded. SHA-256', createHash('sha256').update(bytes).digest('hex'));
  if (process.argv.includes('--soak')) {
    const route = () => receiver.evaluate(`(async () => {
      const stats = await testPeer.getStats();
      const transport = [...stats.values()].find(s => s.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId);
      return { local: stats.get(pair?.localCandidateId)?.candidateType, remote: stats.get(pair?.remoteCandidateId)?.candidateType,
        state: pair?.state, interruptions: SlipstreamPeer.diagnostics.filter(e => e.event === 'connection recovery started').length };
    })()`);
    console.log('Local Chrome before idle', await route());
    const since = Date.now();
    await pause(300000);
    const after = await route();
    assert.equal(after.state, 'succeeded');
    console.log('Local Chrome after', Math.round((Date.now() - since) / 1000), 'idle seconds', after);
  }
  await checkSharing({ sender, receiver, temp, waitFor });
  await sender.click('#btn-send-another');
  await sender.selectFiles('#file-input', [fixture]);
  await sender.click('#btn-send-file');
  await waitFor('second offer',()=>receiver.evaluate("!!document.querySelector('#btn-accept-transfer').getClientRects().length"));
  await receiver.evaluate("window.testPeer.close()");
  for (const tab of [sender, receiver]) await waitFor('home after channel close', () => tab.evaluate("!!document.querySelector('#screen-home.active') && !document.querySelector('#home-notice').hidden"));
  assert.equal(await receiver.evaluate("document.querySelectorAll('#saved-files li').length"), 3);
  assert.equal(await receiver.evaluate("document.querySelector('#saved-files a').href.startsWith('blob:')"), true);
  await receiver.click('#saved-files button');
  assert.ok(await receiver.evaluate("document.querySelector('#file-viewer').open"));
  await receiver.click('#file-viewer button');
  assert.ok(await gated(sender));
  await sender.click('.nav-links [data-modal="modal-help"]');
  await sender.click('#btn-download-diagnostics');
  const reportBytes = await waitFor('connection report download', () =>
    readFile(path.join(downloadPath, 'slipstream-connection.json')).catch(() => null));
  const report = JSON.parse(reportBytes);
  assert.equal(report.build, 'phase5');
  assert.ok(report.snapshot.openedAt && report.snapshot.reason);
  assert.ok(report.snapshot.candidateExchange.receivedRows >= report.snapshot.applied);
  assert.equal(report.snapshot.channelOpen, false);
  // A local channel can open before the next polling pass applies any remote candidates.
  const actual = await sender.evaluate('window.appliedCandidates');
  assert.equal(report.snapshot.applied, actual.accepted);
  assert.equal(report.snapshot.applyFailures, actual.failed);
  assert.ok(await sender.evaluate("document.querySelector('#received-text').children.length === 0 && document.querySelector('#activity-list').children.length === 0"));
  assert.ok(report.entries.some(entry => entry.event === 'ICE candidate pairs'));
  assert.ok(!reportBytes.toString().includes('localCandidateId'));
  await sender.click('#modal-help [data-close-modal]');
  console.log('Connection report downloaded after channel closure.');
  // Join again through the full camera pipeline using the host's rendered QR.
  await sender.click('#btn-start-send');
  const cameraCode = await codeOf(sender);
  const qr = await sender.evaluate("document.querySelector('#qr-display canvas').toDataURL()");
  await receiver.click('#btn-start-receive');
  for (const [error, wording] of [['NotAllowedError', 'denied'], ['NotFoundError', 'No camera']]) {
    await receiver.evaluate("navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('', " + JSON.stringify(error) + ") }");
    await receiver.click('#btn-scan-qr');
    await waitFor('scanner error ' + error, () => receiver.evaluate("document.querySelector('#scanner-status').textContent.includes(" + JSON.stringify(wording) + ")"));
    await receiver.click('#scanner-manual');
  }
  await receiver.evaluate(`window.testQR = new Image(); testQR.src = ${JSON.stringify(qr)}; testQR.decode()`);
  await receiver.evaluate(`navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0,0,400,400);
    const draw = () => ctx.drawImage(testQR,60,60,280,280);
    draw();
    const stream = canvas.captureStream(12);
    const timer = setInterval(() => {
      if (stream.getVideoTracks()[0].readyState === 'ended') clearInterval(timer);
      else draw();
    }, 100);
    window.cameraTrack = stream.getVideoTracks()[0];
    return stream;
  }`);
  // First feed an unrelated QR and an expired host link through the same stream.
  const replaceQR = value => receiver.evaluate(`(() => {
    const node = document.createElement('div');
    new QRCode(node, { text: ${JSON.stringify(value)}, width: 200, height: 200 });
    testQR.src = node.querySelector('canvas').toDataURL();
    return testQR.decode();
  })()`);
  await replaceQR('https://example.org/?join=ABCDEF');
  await receiver.click('#btn-scan-qr');
  await waitFor('unrelated QR', () => receiver.evaluate("document.querySelector('#scanner-status').textContent.includes('Unrecognized')"));
  await replaceQR(origin + '/?join=' + replaced);
  await waitFor('retired code', () => receiver.evaluate("document.querySelector('#join-error-msg').textContent.includes('expired')"));
  await receiver.evaluate("testQR.src = " + JSON.stringify(qr) + "; testQR.decode()");
  await receiver.click('#btn-scan-qr');
  await waitFor('QR auto-join', () => receiver.evaluate("!!document.querySelector('#screen-connected.active')"));
  assert.equal(await receiver.evaluate("document.querySelector('#join-code-input').value"), cameraCode);
  assert.equal(await receiver.evaluate("cameraTrack.readyState"), 'ended');
  await sender.click('.settings-trigger');
  await sender.click('#end-session');
  await waitFor('receiver home', () => receiver.evaluate("!!document.querySelector('#screen-home.active')"));
  await sender.click('#btn-start-send');
  const manualCode = await codeOf(sender);
  await receiver.click('#btn-start-receive');
  await receiver.evaluate("document.querySelector('#join-code-input').value=" + JSON.stringify(manualCode));
  await receiver.click('#btn-submit-join');
  await waitFor('manual pairing', () => receiver.evaluate("!!document.querySelector('#screen-connected.active')"));
  // Drive the native state-change listener while leaving the real RTCDataChannel open.
  await receiver.evaluate("Object.defineProperty(testPeer, 'iceConnectionState', {configurable:true, value:'disconnected'}); testPeer.dispatchEvent(new Event('iceconnectionstatechange'))");
  assert.ok(await receiver.evaluate("!!document.querySelector('#screen-connected.active') && document.querySelector('#header-status').classList.contains('recovering')"));
  await receiver.evaluate("delete testPeer.iceConnectionState;testPeer.dispatchEvent(new Event('iceconnectionstatechange'))");
  assert.ok(await receiver.evaluate("document.querySelector('#header-status-text').textContent === 'Connected'"));
  await receiver.evaluate("Object.defineProperty(testPeer, 'iceConnectionState', {configurable:true, value:'disconnected'}); testPeer.dispatchEvent(new Event('iceconnectionstatechange'))");
  await waitFor('recovery expiry', () => receiver.evaluate("!!document.querySelector('#screen-home.active') && !document.querySelector('#home-notice').hidden"));
  console.log('QR camera join, manual join, temporary recovery, recovery timeout and retained verified files passed.');
} catch (error) {
  console.error(error.message);
  throw error;
} finally {
  await Promise.allSettled(closeBrowsers.map(close => close()));
  for (const socket of sockets) socket.close();
  for (const process of processes) process.kill();
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

