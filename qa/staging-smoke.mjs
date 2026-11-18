// Node 18+. Creates a temporary signaling session and deletes it when finished.
import assert from 'node:assert/strict';

const origin = new URL(process.argv[2]).origin;

async function request(path, method, expected, body) {
  const response = await fetch(origin + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, expected, method + ' ' + path.replace(/sessions\/[^/?]+/, 'sessions/{code}'));
  if (expected === 204) {
    assert.equal(await response.text(), '');
    return;
  }
  return response;
}

async function json(path, method, status, body) {
  const response = await request(path, method, status, body);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return response.json();
}

const page = await request('/', 'GET', 200);
assert.match(await page.text(), /<title>Slipstream/);
for (const [path, mime] of [
  ['/css/style.css', /text\/css/],
  ['/slipstream-favicon.svg', /image\/svg\+xml/],
  ...['api', 'app', 'webrtc', 'file-sender', 'file-receiver', 'vendor/qrcode.min'].map(
    name => ['/js/' + name + '.js', /javascript/]),
]) {
  const asset = await request(path, 'GET', 200);
  assert.match(asset.headers.get('content-type') || '', mime);
}
console.log('PASS home and all local frontend assets');

const session = await json('/sessions', 'POST', 201);
assert.match(session.code, /^[A-Z2-9]{6}$/);
assert.ok(Date.parse(session.expiresAt) > Date.now());
const path = '/sessions/' + session.code;
try {
  assert.equal((await json(path, 'GET', 200)).code, session.code);
  for (const type of ['offer', 'answer']) {
    await request(path + '/' + type, 'GET', 204);
    const description = { type, sdp: 'v=0\r\n' };
    assert.equal((await json(path + '/' + type, 'POST', 200, { [type]: description })).status, 'ok');
    assert.deepEqual((await json(path + '/' + type, 'GET', 200))[type], description);
  }
  const ice = path + '/ice-candidates';
  for (const role of ['host', 'joiner']) {
    const candidate = { candidate: 'candidate:1 1 UDP 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    assert.equal((await json(ice, 'POST', 200, { role, candidate })).status, 'ok');
    assert.deepEqual(await json(ice + '?role=' + role, 'GET', 200), { role, candidates: [candidate] });
    assert.deepEqual((await json(ice + '?role=' + role + '&after=1', 'GET', 200)).candidates, []);
  }
  assert.ok((await json(path + '/offer', 'POST', 400, { offer: {} })).error);
  assert.ok((await json(path + '/unknown', 'GET', 404)).error);
  assert.ok((await json('/sessions/!', 'GET', 400)).error);
  assert.ok((await json('/sessions', 'GET', 405)).error);
  console.log('PASS create, lookup, pending and stored SDP, both ICE roles, cursor and error responses');
} finally {
  await request(path, 'DELETE', 204);
}
assert.ok((await json(path, 'GET', 404)).error);
console.log('PASS delete and subsequent missing-session response');
