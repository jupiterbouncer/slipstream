import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

// Runs after the first verified download, on the same local WebRTC connection.
export async function checkSharing({ sender, receiver, temp, waitFor }) {
  const wait = (tab, label, expression) => waitFor(label, () => tab.evaluate(expression));
  const fill = (tab, id, value) => tab.evaluate(
    'document.getElementById(' + JSON.stringify(id) + ').value = ' + JSON.stringify(value));

  await sender.click('#nickname-connection summary');
  await fill(sender, 'nickname', 'Study laptop');
  await sender.click('#save-name');
  await wait(receiver, 'peer nickname', "document.querySelector('#peer-device-label').textContent === 'Study laptop'");
  await sender.click('#share-panel summary');
  await sender.evaluate(`Object.defineProperty(navigator.clipboard, 'readText', {
    configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); }
  })`);
  await sender.click('#paste-text');
  await wait(sender, 'manual paste fallback', "document.activeElement.id === 'share-text' && document.querySelector('#share-feedback').textContent.includes('Paste directly')");
  await sender.evaluate('delete navigator.clipboard.readText');
  const snippet = '<b>literal text</b>\n  second line';
  await fill(sender, 'share-text', snippet);
  await sender.click('#send-text');
  await wait(receiver, 'literal text delivery', "document.querySelector('#received-text pre')?.textContent === " + JSON.stringify(snippet));
  assert.ok(await receiver.evaluate("!document.querySelector('#received-text b')"));
  await fill(sender, 'share-text', 'https://example.org/notes');
  await sender.click('#send-text');
  await wait(receiver, 'explicit safe link', "document.querySelector('#received-text a')?.href === 'https://example.org/notes'");

  await receiver.click('#request-file');
  await sender.click('#decline-request');
  await wait(receiver, 'request declined', "document.querySelector('#request-status').textContent.includes('declined')");
  await receiver.click('#request-file');
  await sender.command('Page.setInterceptFileChooserDialog', { enabled: true });
  await sender.click('#approve-request');
  const requested = path.join(temp, 'requested.txt');
  await writeFile(requested, snippet);
  await sender.selectFiles('#request-picker', [requested]);
  await sender.command('Page.setInterceptFileChooserDialog', { enabled: false });
  await wait(receiver, 'requested file offer', "document.querySelector('#incoming-filename').textContent === 'requested.txt'");
  assert.equal(await receiver.evaluate("document.querySelectorAll('#verified-files li').length"), 1);
  await receiver.click('#btn-accept-transfer');
  await wait(receiver, 'requested file verified', "document.querySelectorAll('#verified-files li').length === 2");
  await receiver.click('#verified-files li:last-child button');
  await wait(receiver, 'verified text preview', "document.querySelector('#file-viewer pre')?.textContent === " + JSON.stringify(snippet));
  await receiver.click('#file-viewer button');

  await sender.click('#btn-send-another');
  const longName = 'notes-'.repeat(18) + '.txt';
  const longPath = path.join(temp, longName);
  const picture = path.join(temp, 'picture.gif');
  await writeFile(longPath, 'Queue order test');
  await writeFile(picture, Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
  await sender.selectFiles('#file-input', [longPath, picture]);
  await sender.click('#queue-list li:last-child button');
  const url = await wait(sender, 'local image preview', "document.querySelector('#file-viewer img')?.src");
  await sender.click('#file-viewer button');
  await wait(sender, 'preview URL revoked', 'fetch(' + JSON.stringify(url) + ').then(() => false, () => true)');

  for (const tab of [sender, receiver]) {
    await tab.evaluate("for (const panel of document.querySelectorAll('#session-tools details')) panel.open = true");
    for (const width of [320, 360, 375, 390, 430, 768, 1280]) {
      await tab.command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
      const overflow = await tab.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');
      assert.equal(overflow, false, 'Sharing controls overflow at ' + width);
    }
  }
  await sender.click('#btn-send-file');
  await wait(receiver, 'first queue offer', "document.querySelector('#incoming-filename').textContent === " + JSON.stringify(longName));
  assert.ok(await receiver.evaluate(`(() => {
    const nativeConfirm = window.confirm;
    let prompted = false;
    window.confirm = () => { prompted = true; return false; };
    try { document.querySelector('#end-session').click(); }
    finally { window.confirm = nativeConfirm; }
    return prompted && !!document.querySelector('#screen-connected.active');
  })()`));
  await receiver.click('#btn-decline-transfer');
  await wait(receiver, 'second queue offer', "document.querySelector('#incoming-filename').textContent === 'picture.gif'");
  await receiver.click('#btn-accept-transfer');
  await wait(sender, 'verified totals', "document.querySelector('#session-stats').textContent.includes('3 verified files')");
  await sender.click('#clear-activity');
  assert.equal(await sender.evaluate("document.querySelector('#activity-list').children.length"), 0);
  assert.ok(await sender.evaluate("document.querySelector('#session-stats').textContent.includes('3 verified files')"));
  await sender.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.ok(await sender.evaluate("parseFloat(getComputedStyle(document.querySelector('#transfer-trail-fill')).transitionDuration) < 0.001"));
  const help = 'button[data-modal="modal-help"]';
  await sender.click(help);
  assert.ok(await sender.evaluate("document.activeElement.closest('#modal-help') !== null"));
  for (const type of ['keyDown', 'keyUp']) await sender.command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(sender, 'Escape restores focus', "document.activeElement.dataset.modal === 'modal-help' && !document.querySelector('#modal-help').open");
  console.log('Phase 3 sharing, per-file consent, preview cleanup, dialog focus and seven responsive widths passed.');
}
