import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// Optional review artifacts. Screens contain only the test session and synthetic files.
async function captureWorkspace(tab, directory) {
  await mkdir(directory, { recursive: true });
  await tab.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const view of ['files', 'messages', 'activity', 'settings']) {
    await tab.click(view === 'settings' ? '.settings-trigger' : '#tab-' + view);
    await tab.evaluate('window.scrollTo(0, 0); Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
    const { data } = await tab.command('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, view + '.png'), Buffer.from(data, 'base64'));
  }
  await tab.click('#modal-settings [data-close-modal]');
  await tab.click('#tab-files');
}

// Runs after the first verified download, on the same local WebRTC connection.
export async function checkSharing({ sender, receiver, temp, waitFor }) {
  const wait = (tab, label, expression) => waitFor(label, () => tab.evaluate(expression));
  const fill = (tab, id, value) => tab.evaluate(
    'document.getElementById(' + JSON.stringify(id) + ').value = ' + JSON.stringify(value));

  await sender.click('.settings-trigger');
  await fill(sender, 'nickname', '   ');
  await sender.click('#save-name');
  assert.ok(await sender.evaluate("document.activeElement.id === 'nickname' && document.activeElement.getAttribute('aria-invalid') === 'true'"));
  await fill(sender, 'nickname', 'Study laptop');
  await sender.click('#save-name');
  await wait(receiver, 'peer nickname', "document.querySelector('#peer-device-label').textContent === 'Study laptop'");
  assert.equal(await sender.evaluate("document.querySelector('#name-feedback').textContent"), 'Name updated');
  await wait(sender, 'temporary name confirmation clears', "document.querySelector('#name-feedback').textContent === ''");
  await sender.click('#modal-settings [data-close-modal]');
  await sender.click('#tab-messages');
  await receiver.click('#tab-messages');
  assert.ok(await receiver.evaluate("Array.from(document.querySelectorAll('.bubble.peer strong')).every(e => e.textContent === 'Study laptop')"));
  await wait(receiver, 'persistent coral ring', "getComputedStyle(document.querySelector('#tab-messages circle')).strokeDashoffset === '0px'");

  await sender.evaluate(`Object.defineProperty(navigator.clipboard, 'readText', {
    configurable: true, value: async () => { throw new DOMException('Denied', 'NotAllowedError'); }
  })`);
  await sender.click('#paste-text');
  await wait(sender, 'manual paste fallback', "document.activeElement.id === 'share-text' && document.querySelector('#share-feedback').textContent.includes('Paste directly')");
  await sender.evaluate('delete navigator.clipboard.readText');
  const snippet = '<b>literal text</b>\n  second line';
  await fill(sender, 'share-text', snippet);
  await sender.click('#send-text');
  await wait(receiver, 'literal text delivery', "document.querySelector('#received-text article:last-child pre')?.textContent === " + JSON.stringify(snippet));
  assert.ok(await receiver.evaluate("!document.querySelector('#received-text b')"));
  const longLink = 'https://example.org/notes?' + 'x'.repeat(160);
  await fill(sender, 'share-text', longLink);
  await sender.click('#send-text');
  await wait(receiver, 'explicit safe link', "document.querySelector('#received-text a')?.href === " + JSON.stringify(longLink));

  await sender.click('#tab-files');
  await receiver.click('#tab-files');
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

  if (process.env.SLIPSTREAM_SCREENSHOTS) await captureWorkspace(sender, process.env.SLIPSTREAM_SCREENSHOTS);

  for (const tab of [sender, receiver]) {

    for (const width of [320, 360, 375, 390, 430, 768, 1280]) {
      await tab.command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
      for (const name of ['messages', 'activity', 'files']) {
        await tab.click('#tab-' + name);
        const layout = await tab.evaluate(`(() => {
          const page = document.querySelector('#view-' + ${JSON.stringify(name)}).getBoundingClientRect();
          const nav = document.querySelector('#tab-files').getBoundingClientRect();
          return { button: nav.width, railRight: nav.right, viewport: innerWidth, gap: nav.left - page.right,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        })()`);
        assert.ok(layout.button >= 44 && layout.railRight <= layout.viewport && layout.gap >= 0 && !layout.overflow,
          name + ' at ' + width + ': ' + JSON.stringify(layout));
      }
    }
  }
  // A shortened viewport exercises composer access; native iOS keyboard behavior needs a device.
  for (const [width, height] of [[390, 385], [844, 390]]) {
    await sender.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await sender.click('#tab-messages');
    await sender.click('#share-text');
    assert.ok(await sender.evaluate(`(() => {
      const send = document.querySelector('#send-text').getBoundingClientRect();
      const field = document.querySelector('#share-text').getBoundingClientRect();
      return send.bottom <= innerHeight + 1 && field.top >= -1 && send.top >= field.bottom &&
        document.querySelector('.workspace-rail').getBoundingClientRect().left >= send.right;
    })()`), 'composer reachable at ' + width + ' x ' + height);
  }
  await sender.click('#tab-files');
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
  await sender.click('#tab-activity');
  await sender.click('#clear-activity');
  assert.equal(await sender.evaluate("document.querySelector('#activity-list').children.length"), 0);
  assert.ok(await sender.evaluate("document.querySelector('#session-stats').textContent.includes('3 verified files')"));
  await sender.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.ok(await sender.evaluate("parseFloat(getComputedStyle(document.querySelector('#transfer-trail-fill')).transitionDuration) < 0.001"));
  await sender.click('.settings-trigger');
  const help = '#modal-settings [data-modal="modal-help"]';
  await sender.click(help);
  assert.ok(await sender.evaluate("document.activeElement.closest('#modal-help') !== null"));
  for (const type of ['keyDown', 'keyUp']) await sender.command('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(sender, 'Escape restores focus', "document.activeElement.dataset.modal === 'modal-help' && !document.querySelector('#modal-help').open");
  await sender.click('#modal-settings [data-close-modal]');
  await sender.click('#tab-files');
  console.log('Phase 3 sharing, per-file consent, preview cleanup, dialog focus and seven responsive widths passed.');
}
