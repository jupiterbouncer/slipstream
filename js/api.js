/**
 * Slipstream REST Signaling Client
 * Implements the API contract specified in §5.
 * Strictly metadata only; file bytes NEVER pass through these endpoints.
 */

const Api = (() => {
  const BASE_URL = '/sessions';

  async function request(url, options = {}) {
    const defaultHeaders = {
      'Accept': 'application/json',
    };

    if (options.body && typeof options.body === 'string') {
      defaultHeaders['Content-Type'] = 'application/json';
    }

    options.headers = { ...defaultHeaders, ...options.headers };

    const res = await fetch(url, options);

    if (res.status === 204) {
      return null;
    }

    const isJson = res.headers.get('content-type')?.includes('application/json');
    if (!isJson) {
      const err = new Error('The signaling service returned a web page. Open the site in this browser and check the session route.');
      err.status = res.status;
      throw err;
    }
    const data = await res.json();

    if (!res.ok) {
      const errorMsg = data?.error || data?.message || `Request failed with status ${res.status}`;
      const err = new Error(errorMsg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  return {
    /**
     * Create a new pairing session (POST /sessions)
     * Returns { code, expiresAt }
     */
    async createSession() {
      return await request(BASE_URL, {
        method: 'POST',
      });
    },

    /**
     * Validate an existing session code (GET /sessions/{code})
     * Returns { code, expiresAt, createdAt }
     */
    async getSession(code) {
      return await request(`${BASE_URL}/${encodeURIComponent(code)}`, {
        method: 'GET',
      });
    },

    /**
     * Host submits SDP offer (POST /sessions/{code}/offer)
     */
    async sendOffer(code, offer) {
      return await request(`${BASE_URL}/${encodeURIComponent(code)}/offer`, {
        method: 'POST',
        body: JSON.stringify({ offer }),
      });
    },

    /**
     * Joiner polls for SDP offer (GET /sessions/{code}/offer)
     * Returns offer object or null (if 204 No Content)
     */
    async getOffer(code, signal) {
      const res = await request(`${BASE_URL}/${encodeURIComponent(code)}/offer`, {
        signal,
        method: 'GET',
      });
      return res?.offer || null;
    },

    /**
     * Joiner submits SDP answer (POST /sessions/{code}/answer)
     */
    async sendAnswer(code, answer, signal) {
      return await request(`${BASE_URL}/${encodeURIComponent(code)}/answer`, {
        signal,
        method: 'POST',
        body: JSON.stringify({ answer }),
      });
    },

    /**
     * Host polls for SDP answer (GET /sessions/{code}/answer)
     * Returns answer object or null (if 204 No Content)
     */
    async getAnswer(code, signal) {
      const res = await request(`${BASE_URL}/${encodeURIComponent(code)}/answer`, {
        signal,
        method: 'GET',
      });
      return res?.answer || null;
    },

    /**
     * Submit an ICE candidate (POST /sessions/{code}/ice-candidates)
     * role: 'host' | 'joiner' (who is submitting)
     */
    async sendIceCandidate(code, role, candidate) {
      return await request(`${BASE_URL}/${encodeURIComponent(code)}/ice-candidates`, {
        method: 'POST',
        body: JSON.stringify({ role, candidate }),
      });
    },

    /**
     * Retrieve ICE candidates (GET /sessions/{code}/ice-candidates?role=peerRole)
     * peerRole: role of the other party whose candidates we want to fetch
     * Host passes 'joiner'; Joiner passes 'host' (§5, §108)
     */
    async getIceCandidates(code, peerRole, afterIndex = 0, signal) {
      let url = `${BASE_URL}/${encodeURIComponent(code)}/ice-candidates?role=${encodeURIComponent(peerRole)}`;
      if (afterIndex > 0) {
        url += `&after=${afterIndex}`;
      }
      const res = await request(url, {
        signal,
        method: 'GET',
      });
      return res?.candidates || [];
    },

    /**
     * Delete signaling records upon completion or cancellation (POST /sessions/{code}/delete)
     */
    async deleteSession(code) {
      try {
        await request(`${BASE_URL}/${encodeURIComponent(code)}/delete`, {
          method: 'POST',
          body: '{}',
        });
      } catch (err) {
        console.warn('Could not delete session:', err);
      }
    },
  };
})();
