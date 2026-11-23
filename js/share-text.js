function setupTextSharing(byId, getPeer, getName, record) {
  const input = byId('share-text');
  const feedback = byId('share-feedback');
  const log = byId('received-text');
  const form = byId('share-panel');

  function append(text, person) {
    const article = document.createElement('article');
    article.className = 'bubble ' + person;
    const author = document.createElement('strong');
    author.dataset.person = person;
    author.textContent = getName(person);
    const time = document.createElement('time');
    const now = new Date();
    time.dateTime = now.toISOString();
    time.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    time.title = now.toLocaleString();
    const meta = document.createElement('header');
    meta.append(author, time);
    const pre = document.createElement('pre');
    pre.textContent = text;
    article.append(meta, pre);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        if (copy.isConnected) feedback.textContent = 'Copied.';
      } catch {
        if (copy.isConnected) feedback.textContent = 'Select the message and copy manually.';
      }
    };
    article.append(copy);
    const url = AppMessages.link(text);
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open link';
      article.append(link);
    }
    byId('chat-empty').hidden = true;
    log.append(article);
    log.scrollTop = log.scrollHeight;
    record(url ? 'shared a link' : 'sent a message', person);
    if (person === 'peer' && byId('view-messages').hidden) byId('tab-messages').classList.add('unread');
  }

  byId('paste-text').onclick = async () => {
    const peer = getPeer();
    try {
      const text = await navigator.clipboard.readText();
      if (peer === getPeer()) input.value = text;
    } catch {
      if (peer === getPeer()) feedback.textContent = 'Paste directly into the text field.';
    }
    if (peer === getPeer()) input.focus();
  };
  form.onsubmit = event => {
    event.preventDefault();
    const text = input.value;
    if (!AppMessages.send(getPeer(), 'share-text', { text })) {
      feedback.textContent = 'Enter a message of up to 8 KiB and check your connection.';
      return;
    }
    append(text, 'local');
    input.value = feedback.textContent = '';
    input.focus();
  };
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  return {
    receive(text) { append(text, 'peer'); },
    clear() {
      input.value = feedback.textContent = '';
      log.replaceChildren();
      byId('chat-empty').hidden = false;
      byId('tab-messages').classList.remove('unread');
    },
  };
}
