const Config = {
  _iceServersPromise: null,

  fetchIceServers() {
    if (this._iceServersPromise) return this._iceServersPromise;

    this._iceServersPromise = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout

        const response = await fetch('/api/ice-config', { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (!data.iceServers || data.iceServers.length === 0) {
          throw new Error('Empty ICE server list returned');
        }

        console.log(`[Config] Loaded ${data.iceServers.length} ICE servers from server`);
        return data.iceServers;
      } catch (error) {
        console.warn('[Config] Failed to fetch ICE config, using STUN fallback:', error.message);
        // Basic fallback — the server should ideally return TURN too
        return [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          // Open relay as client-side emergency fallback
          { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
        ];
      }
    })();

    return this._iceServersPromise;
  }
};
