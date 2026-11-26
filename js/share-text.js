function setupTextSharing(byId, getPeer, getName, record) {
  const input = byId('share-text');
  const feedback = byId('share-feedback');
  const log = byId('received-text');
  const form = byId('share-panel');

  let feedbackTimer;
  function notice(message, temporary = false) {
    clearTimeout(feedbackTimer);
    feedback.textContent = message;
    if (temporary) feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 2000);
  }

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
    const url = AppMessages.link(text);
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = text;
      pre.append(link);
    } else {
      pre.textContent = text;
    }
    article.append(meta, pre);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        if (copy.isConnected) notice('Copied', true);
      } catch {
        if (copy.isConnected) notice('Select the message and copy manually.');
      }
    };
    article.append(copy);
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
      if (peer === getPeer()) notice('Paste directly into the text field.');
    }
    if (peer === getPeer()) input.focus();
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (byId('send-text').disabled) return;
    const text = input.value;
    if (!AppMessages.send(getPeer(), 'share-text', { text })) {
      notice('Enter a message up to 8 KiB and check your connection.');
      return;
    }
    append(text, 'local');
    input.value = '';
    notice('Sent', true);
    input.focus();
  };
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  // Safari can resize the visual viewport while leaving the layout viewport unchanged.
  const viewport = window.visualViewport;
  function fitComposer() {
    if (document.activeElement !== input || !viewport || !matchMedia('(max-width: 640px), (max-height: 520px)').matches) return;
    form.parentElement.style.setProperty('--chat-viewport', viewport.height + 'px');
    form.scrollIntoView({ block: 'nearest' });
  }
  viewport?.addEventListener('resize', fitComposer);
  input.addEventListener('focus', fitComposer);
  input.addEventListener('blur', () => form.parentElement.style.removeProperty('--chat-viewport'));

  return {
    receive(text) { append(text, 'peer'); },
    clear() {
      clearTimeout(feedbackTimer);
      input.value = feedback.textContent = '';
      log.replaceChildren();
      byId('chat-empty').hidden = false;
      byId('tab-messages').classList.remove('unread');
    },
  };
}
