import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

// Run against the packaged frontend served by local PHP/MySQL on port 8137.
// The test creates and deletes its own sessions and uses temporary Chrome profiles.
const origin = process.argv[2] || 'http://127.0.0.1:8137';
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
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e || !e.getClientRects().length || e.disabled) return;
      e.scrollIntoView({block:'center'});
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`));
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  }
  await command('Page.enable');
  closeBrowsers.push(() => command('Browser.close'));
  console.log(role + ' Chrome ready');
  return { command, evaluate, click };
}

try {
  const [sender, receiver] = await Promise.all([browser('sender'), browser('receiver')]);
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
  const first = await codeOf(sender);
  await sender.evaluate("Api.deleteSession("+JSON.stringify(first)+")");
  const failure = tab => waitFor('connection failure', () => tab.evaluate("document.querySelector('#transfer-heading').textContent === 'Connection failed'"));
  await failure(sender);
  const gated = tab => tab.evaluate("document.querySelector('#phase-chat').hidden && document.querySelector('#btn-send-test-msg').disabled && !document.querySelector('#screen-connected.active')");
  assert.ok(await gated(sender));
  await sender.click('#btn-retry-transfer');
  const second = await codeOf(sender);
  assert.notEqual(second,first); assert.ok(await gated(sender));
  await receiver.command('Page.navigate',{url:origin});
  await waitFor('receiver app',()=>receiver.evaluate("typeof Api === 'object'"));
  await receiver.evaluate("window.realAnswer = Api.sendAnswer; Api.sendAnswer = async () => { throw Object.assign(new Error('Injected rejection'), {status:403}); }");
  await receiver.click('#btn-start-receive');
  await receiver.evaluate("document.querySelector('#join-code-input').value="+JSON.stringify(second));
  await receiver.click('#btn-submit-join');
  await failure(receiver);
  await receiver.click('#btn-retry-transfer');
  assert.ok(await receiver.evaluate("!!document.querySelector('#screen-join.active') && !document.querySelector('#join-code-input').value"));
  assert.ok(await gated(receiver)); await failure(sender);
  await sender.evaluate("window.postAttempts=0;const sendCandidate=Api.sendIceCandidate;Api.sendIceCandidate=(...args)=>{if(++postAttempts===1) return Promise.reject(Object.assign(new Error('Injected transient error'),{status:503}));return sendCandidate(...args)}");
  await sender.click('#btn-retry-transfer');
  console.log('Both roles recovered from pre-open failures with chat gated.');
  const code = await waitFor('pairing code', async () => {
    const value = await sender.evaluate("document.querySelector('#host-code-text')?.textContent");
    return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(value) && value;
  });
  await receiver.command('Page.navigate', { url: origin + '/?join=' + code });
  for (const browser of [sender, receiver])
    await waitFor('open data channel', () => browser.evaluate("!!document.querySelector('#screen-connected.active')"));
  assert.ok(await sender.evaluate('postAttempts>=2'));
  await sender.evaluate("document.querySelector('#test-message-input').value='recovered chat'; document.querySelector('#btn-send-test-msg').click()");
  await waitFor('chat delivery',()=>receiver.evaluate("document.querySelector('#test-chat-log').textContent.includes('recovered chat')"));
  await receiver.click('#test-message-input');
  await receiver.evaluate("document.querySelector('#test-message-input').value='receiver reply'");
  await receiver.click('#btn-send-test-msg');
  await waitFor('receiver reply',()=>sender.evaluate("document.querySelector('#test-chat-log').textContent.includes('receiver reply')"));
  await receiver.evaluate(`window.receivedProgress=[];const originalChunk=SlipstreamFileReceiver.prototype.handleBinaryChunk;
    SlipstreamFileReceiver.prototype.handleBinaryChunk=function(chunk) {
      originalChunk.call(this,chunk);
      const fill=document.querySelector('#transfer-trail-fill');
      receivedProgress.push({text:document.querySelector('#transfer-percentage-text').textContent,variable:fill.style.getPropertyValue('--trail-progress')});
    };`);
  console.log('Transient ICE POST recovery and bidirectional chat passed.');
  const name = 'slipstream-test.bin', original = randomBytes(1024 * 1024 + 1);
  const fixture = path.join(temp, name);
  await writeFile(fixture, original);
  const { root } = await sender.command('DOM.getDocument');
  const { nodeId } = await sender.command('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
  await sender.command('DOM.setFileInputFiles', { nodeId, files: [fixture] });
  await sender.click('#btn-send-file');
  await waitFor('offer',()=>receiver.evaluate("!!document.querySelector('#btn-accept-transfer').getClientRects().length"));
  await receiver.evaluate("document.querySelector('#test-message-input').value='chat during offer'");
  await receiver.click('#btn-send-test-msg');
  await waitFor('chat during offer',()=>sender.evaluate("document.querySelector('#test-chat-log').textContent.includes('chat during offer')"));
  await receiver.click('#btn-accept-transfer');
  for (const browser of [receiver, sender])
    await waitFor('verified completion', () => browser.evaluate("!!document.querySelector('#transfer-state-pill.completed')"));
  for (const tab of [sender,receiver]) assert.ok(await tab.evaluate("!!document.querySelector('#phase-chat').getClientRects().length && !document.querySelector('#phase-chat').hidden"));
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
        return {ratio:vertical ? f.height/track.height : f.width/track.width, overflow:document.documentElement.scrollWidth>innerWidth};
      })()`);
      assert.ok(Math.abs(dimensions.ratio-percent/100)<0.02, JSON.stringify({width,percent,dimensions}));
      assert.equal(dimensions.overflow,false,'horizontal overflow at '+width);
    }
  }
  await receiver.evaluate("document.querySelector('#transfer-trail-fill').style.setProperty('--trail-progress','100%');document.querySelector('#test-message-input').value='chat after completion'");
  await receiver.click('#btn-send-test-msg');
  await waitFor('chat after completion',()=>sender.evaluate("document.querySelector('#test-chat-log').textContent.includes('chat after completion')"));
  console.log('Chat before/during offers and after completion; actual receiver progress and seven viewport layouts passed.');
  await receiver.click('#btn-download-file');
  const bytes = await waitFor('download', () => readFile(path.join(downloadPath, name)).catch(() => null));
  assert.deepEqual(bytes, original);
  console.log(origin, bytes.length, 'bytes verified and downloaded. SHA-256', createHash('sha256').update(bytes).digest('hex'));
  await sender.click('#btn-send-another');
  await sender.command('DOM.setFileInputFiles', {nodeId,files:[fixture]});
  await sender.click('#btn-send-file');
  await waitFor('second offer',()=>receiver.evaluate("!!document.querySelector('#btn-accept-transfer').getClientRects().length"));
  await receiver.evaluate("window.testPeer.close()");
  await waitFor('interrupted transfer',()=>sender.evaluate("document.querySelector('#transfer-heading').textContent === 'Transfer interrupted'"));
  assert.ok(await gated(sender));
  await sender.click('[data-modal="modal-help"]');
  await sender.click('#btn-download-diagnostics');
  const reportBytes = await waitFor('connection report download', () =>
    readFile(path.join(downloadPath, 'slipstream-connection.json')).catch(() => null));
  const report = JSON.parse(reportBytes);
  assert.ok(report.entries.some(entry => entry.event === 'ICE candidate pairs'));
  assert.ok(report.entries.some(entry => entry.event === 'remote ICE candidate accepted'));
  assert.ok(!reportBytes.toString().includes('localCandidateId'));
  await sender.click('#modal-help [data-close-modal]');
  console.log('Connection report downloaded after channel closure.');
  await sender.click('#btn-retry-transfer');
  assert.notEqual(await codeOf(sender),code);
  await sender.evaluate("document.querySelector('#brand-link').click()");
  console.log('Actual channel close interrupted the second offer and Retry created a fresh pairing.');
} finally {
  await Promise.allSettled(closeBrowsers.map(close => close()));
  for (const socket of sockets) socket.close();
  for (const process of processes) process.kill();
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

