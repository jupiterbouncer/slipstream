// Only a local selection or a verified receiver result can supply file bytes.
async function readPreview({ blob, name, local, verified }) {
  if (!(blob instanceof Blob) || !(verified || (local && blob instanceof File))) return null;
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const starts = (...prefix) => prefix.every((value, i) => bytes[i] === value);
  const header = String.fromCharCode(...bytes);
  let type;
  if (starts(255, 216, 255)) type = 'image/jpeg';
  else if (starts(137, 80, 78, 71, 13, 10, 26, 10)) type = 'image/png';
  else if (/^GIF8[79]a/.test(header)) type = 'image/gif';
  else if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') type = 'image/webp';
  else if (starts(37, 80, 68, 70, 45)) type = 'application/pdf';
  if (type) return { type, blob: blob.slice(0, blob.size, type) };

  if (blob.type.startsWith('text/') || /\.(txt|md|csv|log|json|ya?ml|toml|js|jsx|ts|tsx|css|html?|xml|svg|sh|py|php|java|c|cpp|h|rs|go|sql)$/i.test(name)) {
    const limit = 32 * 1024;
    const text = await blob.slice(0, limit).text();
    if (!text.includes('\0')) return { type: 'text/plain', text, truncated: blob.size > limit };
  }
  return null;
}

function createPreviewDialog(dialog) {
  const content = dialog.querySelector('.preview-content');
  let generation = 0;
  let url;
  function release() {
    generation++;
    content.replaceChildren();
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  dialog.addEventListener('close', () => { if (!dialog.open) release(); });
  return {
    close() {
      if (dialog.open) dialog.close();
      release();
    },
    async open(result) {
      release();
      const current = generation;
      dialog.querySelector('h2').textContent = result.name;
      content.textContent = 'Loading preview…';
      if (!dialog.open) dialog.showModal();
      const preview = await readPreview(result).catch(() => null);
      if (!dialog.open || current !== generation) return;
      if (!preview) {
        content.textContent = 'Preview unavailable for this file.';
        return;
      }
      if (preview.type === 'text/plain') {
        const pre = document.createElement('pre');
        pre.textContent = preview.text;
        content.replaceChildren(pre);
        if (preview.truncated) content.append('Showing the first 32 KiB.');
        return;
      }
      url = URL.createObjectURL(preview.blob);
      if (preview.type === 'application/pdf') {
        const pdf = document.createElement('object');
        pdf.type = preview.type;
        pdf.title = result.name;
        pdf.textContent = 'This browser has no embedded PDF viewer.';
        pdf.data = url;
        content.replaceChildren(pdf);
      } else {
        const img = document.createElement('img');
        img.alt = result.name;
        img.src = url;
        content.replaceChildren(img);
      }
    },
  };
}
