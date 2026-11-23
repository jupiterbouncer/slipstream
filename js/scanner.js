// The host encodes its own join URL. Never navigate to a scanned address.
function scannedJoinCode(value) {
  try {
    const url = new URL(value);
    const code = url.searchParams.get('join')?.toUpperCase();
    const appPath = path => path.replace(/\/index\.html$/, '/');
    if (url.origin === location.origin && appPath(url.pathname) === appPath(location.pathname) &&
        url.searchParams.getAll('join').length === 1 && /^[A-Z2-9]{6}$/.test(code || '')) return code;
  } catch { /* Keep scanning unrelated QR codes. */ }
  return null;
}

function setupScanner(byId, join) {
  const dialog = byId('scanner-dialog');
  const video = byId('scanner-video');
  const status = byId('scanner-status');
  let generation = 0;
  let timer;
  let stream;

  function stop() {
    generation++;
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  }
  function dismiss() {
    stop();
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('close', () => { if (!dialog.open) stop(); });
  window.addEventListener('pagehide', dismiss);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dialog.open) dismiss();
  });
  byId('scanner-manual').onclick = () => {
    dismiss();
    byId('join-code-input').focus();
  };
  return async () => {
    if (dialog.open || byId('btn-submit-join').disabled) return;
    const attempt = ++generation;
    const active = () => attempt === generation && dialog.open;
    dialog.showModal();
    status.textContent = 'Allow camera access to scan the other device’s pairing code.';
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        status.textContent = 'Camera scanning requires HTTPS and a browser with camera access.';
        return;
      }
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (!active()) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      // Load the vendored decoder only when the user opens the camera.
      await import('./vendor/jsQR.js');
      if (!active()) return;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      status.textContent = 'Center the pairing QR code in the frame.';
      function scan() {
        if (!active()) return;
        try {
          if (video.readyState >= 2 && video.videoWidth) {
            const size = Math.min(video.videoWidth, video.videoHeight);
            canvas.width = canvas.height = Math.min(size, 600);
            ctx.drawImage(video, (video.videoWidth-size)/2, (video.videoHeight-size)/2, size, size, 0, 0, canvas.width, canvas.height);
            const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qr = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
            if (qr) {
              const code = scannedJoinCode(qr.data);
              if (code) { dismiss(); join(code); return; }
              status.textContent = 'Unrecognized QR code. Scan the code shown by Slipstream.';
            }
          }
          timer = setTimeout(scan, 150);
        } catch {
          stop();
          status.textContent = 'Could not read the camera. Reopen the scanner or enter the code manually.';
        }
      }
      scan();
    } catch (error) {
      if (!active()) return;
      stop();
      status.textContent = ({
        NotAllowedError: 'Camera access was denied. Allow camera access in browser settings or enter the code manually.',
        NotFoundError: 'No camera found. Enter the pairing code manually.',
        NotReadableError: 'The camera is busy. Close other camera apps and try again.',
      })[error.name] || 'Could not start the scanner. Reopen it or enter the code manually.';
    }
  };
}
