// Auxiliary controls share the ordered channel with Phase 2, using a separate envelope.
const AppMessages = {
  nickname(value) {
    return typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').trim().slice(0, 32).trim() : '';
  },

  valid(message, senderRole) {
    if (!['host', 'joiner'].includes(senderRole) || message?.protocol !== 'slipstream-app'
      || message.version !== 1) return false;
    if (message.type === 'share-text') return typeof message.text === 'string'
      && message.text.length <= 8192 && !!message.text.trim() && new TextEncoder().encode(message.text).length <= 8192;
    return message.type === 'device-name' && !!this.nickname(message.name)
      && message.name === this.nickname(message.name);
  },

  link(text) {
    if (!/^https?:\/\/\S+$/i.test(text)) return null;
    try { return new URL(text).href; } catch { return null; }
  },

  send(peer, type, fields) {
    const message = { ...fields, protocol: 'slipstream-app', version: 1, type };
    if (!peer?.isChannelOpen() || !this.valid(message, peer.role)) return false;
    try {
      peer.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  },
};
