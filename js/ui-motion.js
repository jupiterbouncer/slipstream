// Presentation only. The Phase 2 controller owns file selection, progress and verification.
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('file-dropzone');
  const input = document.getElementById('file-input');
  const toast = document.getElementById('ui-toast');
  let dismissTimer;

  function showToast(message, tone = 'info') {
    clearTimeout(dismissTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add('visible');
    dismissTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  input.addEventListener('click', () => zone.classList.add('picking'));
  for (const event of ['cancel', 'change']) {
    input.addEventListener(event, () => zone.classList.remove('picking'));
  }

  const header = document.getElementById('header-status');
  let connected = header.classList.contains('connected');
  new MutationObserver(() => {
    const next = header.classList.contains('connected');
    if (next === connected) return;
    connected = next;
    showToast(connected ? 'Device connected' : 'Device disconnected');
  }).observe(header, { attributes: true, attributeFilter: ['class'] });

  const pill = document.getElementById('transfer-state-pill');
  const controls = document.getElementById('transfer-controls');
  let lastMessage = '';
  const transferNotice = new MutationObserver(() => {
    let message = '';
    let tone = 'info';
    if (pill.classList.contains('completed') && document.getElementById('btn-download-file')) {
      message = 'File verified and ready to download';
      tone = 'verified';
    } else if (pill.classList.contains('failed')) {
      message = document.getElementById('transfer-heading').textContent;
      tone = 'error';
    } else if (pill.classList.contains('cancelled')) {
      message = 'Transfer cancelled';
    } else if (pill.classList.contains('rejected')) {
      message = 'File offer declined';
    }
    if (message && message !== lastMessage) showToast(message, tone);
    lastMessage = message;
  });
  transferNotice.observe(pill, { attributes: true, attributeFilter: ['class'] });
  transferNotice.observe(controls, { childList: true });
});
