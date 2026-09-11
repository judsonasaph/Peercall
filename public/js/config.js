const Config = {
  iceServers: null,
  
  async fetchIceServers() {
    try {
      const response = await fetch('/api/ice-config');
      const data = await response.json();
      this.iceServers = data.iceServers;
    } catch (error) {
      console.warn('Failed to fetch ICE config, using defaults');
      this.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ];
    }
    return this.iceServers;
  }
};
