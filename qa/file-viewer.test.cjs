const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js/file-viewer.js'), 'utf8'));

test('binary previews require known signatures and trusted provenance', async () => {
  for (const [bytes, type] of [
    [[255,216,255], 'image/jpeg'], [[137,80,78,71,13,10,26,10], 'image/png'],
    ['GIF89a', 'image/gif'], ['RIFF1234WEBP', 'image/webp'], [[37,80,68,70,45], 'application/pdf'],
  ]) {
    const blob = new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], '<tags>.bin');
    assert.equal((await readPreview({ local: true, blob, name: blob.name })).blob.type, type);
    assert.equal(await readPreview({ blob, name: blob.name }), null);
    assert.equal((await readPreview({ verified: true, blob, name: blob.name })).type, type);
  }
  const blob = new Blob(['<b>'], { type: 'image/png' });
  assert.equal(await readPreview({ verified: true, blob, name: 'fake.png' }), null);
});

test('source previews preserve markup as bounded text', async () => {
  const blob = new Blob(['<b>' + 'x'.repeat(40000)]);
  const preview = await readPreview({ blob, name: '<img>.html', verified: true });
  assert.equal(preview.type, 'text/plain');
  assert.equal(preview.text.length, 32768);
  assert.ok(preview.text.startsWith('<b>'));
  assert.ok(preview.truncated);
});
