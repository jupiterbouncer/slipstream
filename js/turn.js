/** Optional TURN discovery. The deadline covers both headers and the JSON body. */
const SlipstreamTurn = (() => {
  const timeoutMs = 4000;

  function validateServers(value) {
    if (!Array.isArray(value) || value.length > 32) throw new Error('invalid-response');
    const servers = [];
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') throw new Error('invalid-response');
      const urls = typeof entry.urls === 'string' ? [entry.urls] : entry.urls;
      if (!Array.isArray(urls) || !urls.length || urls.length > 16) throw new Error('invalid-response');
      for (const url of urls) {
        if (typeof url !== 'string' || url.length > 512) throw new Error('invalid-response');
        const match = /^(stun|stuns|turn|turns):([a-z0-9.-]+|\[[0-9a-f:]+\])(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url);
        if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) throw new Error('invalid-response');
        if (/^(stun|stuns)$/i.test(match[1]) && match[4]) throw new Error('invalid-response');
        if (match[1].toLowerCase() === 'turns' && match[4] === 'udp') throw new Error('invalid-response');
      }
      const server = { urls: [...urls] };
      if (urls.some(url => /^turns?:/i.test(url))) {
        if (typeof entry.username !== 'string' || !entry.username.length || entry.username.length > 1024
          || typeof entry.credential !== 'string' || !entry.credential.length || entry.credential.length > 4096) {
          throw new Error('invalid-response');
        }
        server.username = entry.username;
        server.credential = entry.credential;
      }
      servers.push(server);
    }
    if (!servers.some(server => server.urls.some(url => /^turns?:/i.test(url)))) throw new Error('invalid-response');
    return servers;
  }

  async function load(config, { signal, log }) {
    if (!config?.domain && !config?.apiKey) {
      log('TURN configuration', { outcome: 'disabled' });
      return [];
    }
    if (typeof config.domain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.metered\.live$/i.test(config.domain)
      || typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 2048) {
      log('TURN configuration', { outcome: 'invalid-config' });
      return [];
    }
    if (signal.aborted) return [];
    const controller = new AbortController();
    let timer;
    let abort;
    const deadline = new Promise((resolve, reject) => {
      abort = () => { controller.abort(); reject(new Error('cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    let outcome = 'request-failed';
    try {
      const url = new URL(`https://${config.domain}/api/v1/turn/credentials`);
      url.searchParams.set('apiKey', config.apiKey);
      const request = async () => {
        const response = await fetch(url.href, {
          signal: controller.signal, credentials: 'omit', cache: 'no-store',
          redirect: 'error', referrerPolicy: 'no-referrer',
        });
        if (!response.ok) { outcome = 'http-error'; throw new Error(); }
        outcome = 'invalid-response';
        return validateServers(await response.json());
      };
      const servers = await Promise.race([request(), deadline]);
      if (signal.aborted) return [];
      log('TURN configuration', { outcome: 'available', servers: servers.length });
      return servers;
    } catch {
      if (!signal.aborted) {
        // Provider errors and URLs can contain credentials. Log fixed categories only.
        log('TURN configuration', { outcome: controller.signal.aborted ? 'timeout' : outcome });
      }
      return [];
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  return { load };
})();
