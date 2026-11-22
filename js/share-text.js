function setupTextSharing(byId, getPeer, record) {
  const input = byId('share-text');
  const feedback = byId('share-feedback');
  const received = byId('received-text');
  byId('paste-text').onclick = async () => {
    const peer = getPeer();
    try {
      const text = await navigator.clipboard.readText();
      if (peer === getPeer()) input.value = text;
    } catch {
      if (peer !== getPeer()) return;
      feedback.textContent = 'Paste directly into the text field.';
      input.focus();
    }
  };
  byId('send-text').onclick = () => {
    const text = input.value;
    if (!AppMessages.send(getPeer(), 'share-text', { text })) {
      feedback.textContent = 'Use 1–8192 UTF-8 bytes and an open connection.';
      return;
    }
    record(AppMessages.link(text) ? 'You shared a link' : 'You shared text');
    input.value = '';
    feedback.textContent = 'Sent.';
  };
  return {
    receive(text, name) {
      const article = document.createElement('article');
      const pre = document.createElement('pre');
      pre.textContent = text;
      const copy = document.createElement('button');
      copy.className = 'btn btn-secondary';
      copy.textContent = 'Copy';
      copy.onclick = async () => {
        let status;
        try {
          await navigator.clipboard.writeText(text);
          status = 'Copied.';
        } catch {
          status = 'Select the received text and copy manually.';
        }
        if (copy.isConnected) feedback.textContent = status;
      };
      article.append(pre, copy);
      const url = AppMessages.link(text);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open link';
        article.append(' ', link);
      }
      received.append(article);
      byId('share-panel').open = true;
      feedback.textContent = 'Received from ' + name;
      record(name + (url ? ' shared a link' : ' shared text'));
    },
    clear() {
      input.value = feedback.textContent = '';
      received.replaceChildren();
    },
  };
}
