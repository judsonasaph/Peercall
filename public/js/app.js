/* ==========================================================================
   PeerCall — Main Application Logic
   Anonymous P2P Video Calls via WebRTC
   ========================================================================== */

/* ==========================================================================
   1. State Management
   ========================================================================== */
const state = {
  socket: null,
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  roomCode: null,
  isCreator: false,
  isMuted: false,
  isCameraOff: false,
  joinCountdownInterval: null,
  creatorCountdownInterval: null,
  iceCandidateQueue: [],
  isRemoteDescriptionSet: false
};

/* ==========================================================================
   2. DOM References — populated on DOMContentLoaded
   ========================================================================== */
const dom = {};

function cacheDom() {
  dom.views = document.querySelectorAll('.view');

  // Home View
  dom.btnCreate = document.getElementById('btn-create');
  dom.btnJoin = document.getElementById('btn-join');
  dom.inputCode = document.getElementById('input-code');

  // Waiting View
  dom.creatorWaiting = document.getElementById('creator-waiting');
  dom.joinerWaiting = document.getElementById('joiner-waiting');
  dom.displayCode = document.getElementById('display-code');
  dom.btnCopy = document.getElementById('btn-copy');
  dom.btnCancelWait = document.getElementById('btn-cancel-wait');
  dom.joinCountdownTimer = document.getElementById('join-countdown-timer');

  // Call View
  dom.localVideo = document.getElementById('local-video');
  dom.remoteVideo = document.getElementById('remote-video');
  dom.localPlaceholder = document.getElementById('local-placeholder');
  dom.remotePlaceholder = document.getElementById('remote-placeholder');
  dom.btnToggleMic = document.getElementById('btn-toggle-mic');
  dom.btnToggleCam = document.getElementById('btn-toggle-cam');
  dom.btnEndCall = document.getElementById('btn-end-call');
  dom.micOnIcon = document.getElementById('mic-on-icon');
  dom.micOffIcon = document.getElementById('mic-off-icon');
  dom.camOnIcon = document.getElementById('cam-on-icon');
  dom.camOffIcon = document.getElementById('cam-off-icon');

  // Overlays & Prompts
  dom.joinPrompt = document.getElementById('join-prompt');
  dom.countdownTimer = document.getElementById('countdown-timer');
  dom.btnAllow = document.getElementById('btn-allow');
  dom.btnDeny = document.getElementById('btn-deny');
  dom.permissionOverlay = document.getElementById('permission-overlay');
  dom.btnRetryPermissions = document.getElementById('btn-retry-permissions');
  dom.btnCancelPermissions = document.getElementById('btn-cancel-permissions');

  // Status & Toasts
  dom.connectionStatus = document.getElementById('connection-status');
  dom.statusDot = document.getElementById('status-dot');
  dom.statusText = document.getElementById('status-text');
  dom.toastContainer = document.getElementById('toast-container');
}

/* ==========================================================================
   3. Socket.io Connection
   ========================================================================== */
function initSocket() {
  state.socket = io();

  // Room created — creator receives the code
  state.socket.on('room-created', (data) => {
    state.roomCode = data.code;
    state.isCreator = true;
    showCreatorWaiting(state.roomCode);
  });

  // Join request received — shown to creator
  state.socket.on('join-request', () => {
    showJoinPrompt();
  });

  // Join approved — both parties
  state.socket.on('join-approved', () => {
    hideJoinPrompt();
    clearInterval(state.joinCountdownInterval);
    showCallView();
    if (state.isCreator) {
      // Creator initiates the WebRTC offer
      createPeerConnection().then(() => createOffer());
    } else {
      // Joiner creates peer connection and waits for the offer
      createPeerConnection();
    }
  });

  // Join denied
  state.socket.on('join-denied', () => {
    showToast('Your request to join was denied.', 'warning');
    cleanupAndReturnHome();
  });

  // Join timed out
  state.socket.on('join-timeout', () => {
    showToast('Join request timed out. The host did not respond.', 'warning');
    cleanupAndReturnHome();
  });

  // Join error
  state.socket.on('join-error', (data) => {
    showToast(data.message || 'Error joining room.', 'error');
    cleanupAndReturnHome();
  });

  // WebRTC signaling
  state.socket.on('webrtc-offer', async (data) => {
    await handleOffer(data.sdp);
  });

  state.socket.on('webrtc-answer', async (data) => {
    await handleAnswer(data.sdp);
  });

  state.socket.on('ice-candidate', (data) => {
    handleIceCandidate(data.candidate);
  });

  // Peer left
  state.socket.on('peer-left', () => {
    showToast('The other person left the call.', 'info');
    cleanupAndReturnHome();
  });

  // Connection issues
  state.socket.on('connect_error', () => {
    showToast('Connection to server lost. Retrying...', 'error');
  });

  state.socket.on('disconnect', () => {
    showToast('Disconnected from server.', 'warning');
  });

  state.socket.io.on('reconnect', () => {
    showToast('Reconnected to server!', 'success');
  });
}

/* ==========================================================================
   4. View Management
   ========================================================================== */
function showView(viewId) {
  if (!dom.views) return;
  dom.views.forEach(view => {
    if (view.id === viewId) {
      view.style.display = 'flex';
      // Force reflow then add active for CSS transition
      requestAnimationFrame(() => {
        view.classList.add('active');
      });
    } else {
      view.classList.remove('active');
      // Delay hiding to allow fade-out
      setTimeout(() => {
        if (!view.classList.contains('active')) {
          view.style.display = 'none';
        }
      }, 300);
    }
  });
}

function showCreatorWaiting(code) {
  if (dom.displayCode) dom.displayCode.textContent = code;
  if (dom.creatorWaiting) dom.creatorWaiting.style.display = 'flex';
  if (dom.joinerWaiting) dom.joinerWaiting.style.display = 'none';
  hideJoinPrompt();
  showView('waiting-view');
}

function showJoinerWaiting() {
  if (dom.creatorWaiting) dom.creatorWaiting.style.display = 'none';
  if (dom.joinerWaiting) dom.joinerWaiting.style.display = 'flex';
  showView('waiting-view');

  // Start 30s countdown for joiner
  let timeLeft = 30;
  if (dom.joinCountdownTimer) dom.joinCountdownTimer.textContent = timeLeft;

  clearInterval(state.joinCountdownInterval);
  state.joinCountdownInterval = setInterval(() => {
    timeLeft--;
    if (dom.joinCountdownTimer) dom.joinCountdownTimer.textContent = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(state.joinCountdownInterval);
    }
  }, 1000);
}

function showJoinPrompt() {
  if (dom.joinPrompt) dom.joinPrompt.classList.add('active');

  let timeLeft = 30;
  if (dom.countdownTimer) dom.countdownTimer.textContent = timeLeft;

  clearInterval(state.creatorCountdownInterval);
  state.creatorCountdownInterval = setInterval(() => {
    timeLeft--;
    if (dom.countdownTimer) dom.countdownTimer.textContent = timeLeft;
    if (timeLeft <= 0) {
      clearInterval(state.creatorCountdownInterval);
      hideJoinPrompt();
    }
  }, 1000);
}

function hideJoinPrompt() {
  if (dom.joinPrompt) dom.joinPrompt.classList.remove('active');
  clearInterval(state.creatorCountdownInterval);
}

function showCallView() {
  showView('call-view');
  updateConnectionStatus('checking', 'Connecting...');
}

/* ==========================================================================
   5. Room Management
   ========================================================================== */
async function createRoom() {
  const mediaSuccess = await requestMedia();
  if (mediaSuccess) {
    state.socket.emit('create-room');
  }
}

async function joinRoom() {
  const codeRaw = dom.inputCode ? dom.inputCode.value : '';
  const code = formatCode(codeRaw);
  
  if (!code || code.length !== 6 || !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
    showToast('Please enter a valid 6-character room code.', 'warning');
    return;
  }

  state.roomCode = code;
  state.isCreator = false;

  const mediaSuccess = await requestMedia();
  if (mediaSuccess) {
    state.socket.emit('join-request', { code: state.roomCode });
    showJoinerWaiting();
  }
}

function handleJoinResponse(approved) {
  state.socket.emit('join-response', { approved });
  hideJoinPrompt();
}

function leaveRoom() {
  if (state.roomCode && state.socket) {
    state.socket.emit('leave-room');
  }
  cleanupAndReturnHome();
}

function cancelWait() {
  if (state.roomCode && state.socket) {
    state.socket.emit('leave-room');
  }
  cleanupAndReturnHome();
}

function cleanupAndReturnHome() {
  cleanupWebRTC();
  stopMedia();
  clearInterval(state.joinCountdownInterval);
  clearInterval(state.creatorCountdownInterval);
  state.roomCode = null;
  state.isCreator = false;
  state.isMuted = false;
  state.isCameraOff = false;
  hideJoinPrompt();
  resetControlButtons();
  showView('home-view');
}

function resetControlButtons() {
  if (dom.btnToggleMic) dom.btnToggleMic.classList.remove('muted');
  if (dom.btnToggleCam) dom.btnToggleCam.classList.remove('muted');
  if (dom.micOnIcon) dom.micOnIcon.style.display = 'block';
  if (dom.micOffIcon) dom.micOffIcon.style.display = 'none';
  if (dom.camOnIcon) dom.camOnIcon.style.display = 'block';
  if (dom.camOffIcon) dom.camOffIcon.style.display = 'none';
}

/* ==========================================================================
   6. Media Management
   ========================================================================== */
async function requestMedia() {
  try {
    // Hide permission overlay if showing
    if (dom.permissionOverlay) dom.permissionOverlay.classList.remove('active');

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.localStream = stream;

    if (dom.localVideo) {
      dom.localVideo.srcObject = stream;
    }
    return true;
  } catch (err) {
    console.error('Error accessing media devices:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      if (dom.permissionOverlay) dom.permissionOverlay.classList.add('active');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      showToast('No camera or microphone found on your device.', 'error');
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      showToast('Camera or microphone is already in use by another application.', 'error');
    } else {
      showToast('Could not access camera/microphone: ' + err.message, 'error');
    }
    return false;
  }
}

function stopMedia() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => track.stop());
    state.localStream = null;
  }
  if (dom.localVideo) dom.localVideo.srcObject = null;
  if (dom.remoteVideo) dom.remoteVideo.srcObject = null;
}

function toggleMic() {
  if (!state.localStream) return;
  const audioTracks = state.localStream.getAudioTracks();
  if (audioTracks.length === 0) return;

  state.isMuted = !state.isMuted;
  audioTracks.forEach(track => {
    track.enabled = !state.isMuted;
  });

  if (dom.btnToggleMic) {
    dom.btnToggleMic.classList.toggle('muted', state.isMuted);
  }
  if (dom.micOnIcon) dom.micOnIcon.style.display = state.isMuted ? 'none' : 'block';
  if (dom.micOffIcon) dom.micOffIcon.style.display = state.isMuted ? 'block' : 'none';
}

function toggleCamera() {
  if (!state.localStream) return;
  const videoTracks = state.localStream.getVideoTracks();
  if (videoTracks.length === 0) return;

  state.isCameraOff = !state.isCameraOff;
  videoTracks.forEach(track => {
    track.enabled = !state.isCameraOff;
  });

  if (dom.btnToggleCam) {
    dom.btnToggleCam.classList.toggle('muted', state.isCameraOff);
  }
  if (dom.camOnIcon) dom.camOnIcon.style.display = state.isCameraOff ? 'none' : 'block';
  if (dom.camOffIcon) dom.camOffIcon.style.display = state.isCameraOff ? 'block' : 'none';
  if (dom.localPlaceholder) dom.localPlaceholder.style.display = state.isCameraOff ? 'flex' : 'none';
}

/* ==========================================================================
   7. WebRTC Management
   ========================================================================== */
async function createPeerConnection() {
  const iceServers = await Config.fetchIceServers();

  state.peerConnection = new RTCPeerConnection({ iceServers });
  state.isRemoteDescriptionSet = false;
  state.iceCandidateQueue = [];

  // Send ICE candidates to the peer
  state.peerConnection.onicecandidate = (event) => {
    if (event.candidate && state.socket) {
      state.socket.emit('ice-candidate', { candidate: event.candidate });
    }
  };

  // Receive remote tracks
  state.peerConnection.ontrack = (event) => {
    state.remoteStream = event.streams[0];
    if (dom.remoteVideo) {
      dom.remoteVideo.srcObject = state.remoteStream;
    }
    if (dom.remotePlaceholder) {
      dom.remotePlaceholder.style.display = 'none';
    }
  };

  // Monitor connection state
  state.peerConnection.oniceconnectionstatechange = () => {
    if (!state.peerConnection) return;
    const iceState = state.peerConnection.iceConnectionState;
    console.log('[WebRTC] ICE Connection State:', iceState);

    switch (iceState) {
      case 'new':
      case 'checking':
        updateConnectionStatus('checking', 'Connecting...');
        break;
      case 'connected':
      case 'completed':
        updateConnectionStatus('connected', 'Connected');
        break;
      case 'disconnected':
        updateConnectionStatus('disconnected', 'Reconnecting...');
        showToast('Connection interrupted. Attempting to reconnect...', 'warning');
        break;
      case 'failed':
        updateConnectionStatus('failed', 'Connection failed');
        showToast('Could not establish connection. Check your network.', 'error');
        break;
      case 'closed':
        break;
    }
  };

  // Add local tracks to the connection
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      state.peerConnection.addTrack(track, state.localStream);
    });
  }
}

async function createOffer() {
  if (!state.peerConnection) return;
  try {
    const offer = await state.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await state.peerConnection.setLocalDescription(offer);
    if (state.socket) {
      state.socket.emit('webrtc-offer', { sdp: offer });
    }
  } catch (err) {
    console.error('[WebRTC] Error creating offer:', err);
    showToast('Failed to initiate connection.', 'error');
  }
}

async function handleOffer(sdp) {
  if (!state.peerConnection) {
    await createPeerConnection();
  }

  try {
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    state.isRemoteDescriptionSet = true;
    processIceCandidateQueue();

    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    if (state.socket) {
      state.socket.emit('webrtc-answer', { sdp: answer });
    }
  } catch (err) {
    console.error('[WebRTC] Error handling offer:', err);
    showToast('Error establishing connection.', 'error');
  }
}

async function handleAnswer(sdp) {
  if (!state.peerConnection) return;
  try {
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    state.isRemoteDescriptionSet = true;
    processIceCandidateQueue();
  } catch (err) {
    console.error('[WebRTC] Error handling answer:', err);
  }
}

function handleIceCandidate(candidate) {
  if (!candidate) return;
  const rtcCandidate = new RTCIceCandidate(candidate);
  if (state.peerConnection && state.isRemoteDescriptionSet) {
    state.peerConnection.addIceCandidate(rtcCandidate).catch(e =>
      console.error('[WebRTC] Error adding ICE candidate:', e)
    );
  } else {
    // Queue candidates until remote description is set
    state.iceCandidateQueue.push(rtcCandidate);
  }
}

function processIceCandidateQueue() {
  while (state.iceCandidateQueue.length > 0) {
    const candidate = state.iceCandidateQueue.shift();
    if (state.peerConnection) {
      state.peerConnection.addIceCandidate(candidate).catch(e =>
        console.error('[WebRTC] Error adding queued ICE candidate:', e)
      );
    }
  }
}

function cleanupWebRTC() {
  if (state.peerConnection) {
    state.peerConnection.onicecandidate = null;
    state.peerConnection.ontrack = null;
    state.peerConnection.oniceconnectionstatechange = null;
    state.peerConnection.close();
    state.peerConnection = null;
  }
  state.isRemoteDescriptionSet = false;
  state.iceCandidateQueue = [];
  state.remoteStream = null;
  if (dom.remotePlaceholder) dom.remotePlaceholder.style.display = 'flex';
}

/* ==========================================================================
   8. Toast Notification System
   ========================================================================== */
function showToast(message, type = 'info', duration = 5000) {
  if (!dom.toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-content">${message}</div>
    <div class="toast-progress" style="animation: toast-progress ${duration}ms linear forwards;"></div>
  `;

  // Click to dismiss
  toast.addEventListener('click', () => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  });

  dom.toastContainer.appendChild(toast);

  // Max 5 toasts visible
  while (dom.toastContainer.children.length > 5) {
    dom.toastContainer.removeChild(dom.toastContainer.firstChild);
  }

  // Auto-dismiss
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('hiding');
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 300);
    }
  }, duration);
}

/* ==========================================================================
   9. Utility Functions
   ========================================================================== */
function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Room code copied to clipboard!', 'success', 3000);
    // Briefly show checkmark on copy button
    if (dom.btnCopy) {
      const original = dom.btnCopy.innerHTML;
      dom.btnCopy.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => {
        dom.btnCopy.innerHTML = original;
      }, 2000);
    }
  }).catch(() => {
    // Fallback: select text for manual copy
    showToast('Press Ctrl+C to copy the code.', 'info');
  });
}

function formatCode(code) {
  return code ? code.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '').trim() : '';
}

function updateConnectionStatus(status, text) {
  if (dom.statusText) dom.statusText.textContent = text;
  if (dom.statusDot) {
    dom.statusDot.className = 'status-dot';
    dom.statusDot.classList.add(status);
  }
}

/* ==========================================================================
   10. Event Listeners — Initialization
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  // Cache all DOM references
  cacheDom();

  // Initialize Socket.io
  if (typeof io !== 'undefined') {
    initSocket();
  } else {
    console.error('[PeerCall] Socket.io library not loaded!');
    showToast('Failed to load — please refresh the page.', 'error', 10000);
  }

  // Home view buttons
  if (dom.btnCreate) dom.btnCreate.addEventListener('click', createRoom);
  if (dom.btnJoin) dom.btnJoin.addEventListener('click', joinRoom);

  // Code input — auto-uppercase, filter invalid chars, Enter to join
  if (dom.inputCode) {
    dom.inputCode.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') joinRoom();
    });
    dom.inputCode.addEventListener('input', () => {
      dom.inputCode.value = formatCode(dom.inputCode.value);
    });
  }

  // Waiting view
  if (dom.btnCopy) dom.btnCopy.addEventListener('click', () => copyToClipboard(state.roomCode));
  if (dom.btnCancelWait) dom.btnCancelWait.addEventListener('click', cancelWait);

  // Join approval prompt
  if (dom.btnAllow) dom.btnAllow.addEventListener('click', () => handleJoinResponse(true));
  if (dom.btnDeny) dom.btnDeny.addEventListener('click', () => handleJoinResponse(false));

  // Call controls
  if (dom.btnToggleMic) dom.btnToggleMic.addEventListener('click', toggleMic);
  if (dom.btnToggleCam) dom.btnToggleCam.addEventListener('click', toggleCamera);
  if (dom.btnEndCall) dom.btnEndCall.addEventListener('click', leaveRoom);

  // Permission overlay
  if (dom.btnRetryPermissions) dom.btnRetryPermissions.addEventListener('click', async () => {
    const success = await requestMedia();
    if (success) {
      // Re-attempt whatever the user was trying before
      if (state.isCreator) {
        state.socket.emit('create-room');
      } else if (state.roomCode) {
        state.socket.emit('join-request', { code: state.roomCode });
        showJoinerWaiting();
      }
    }
  });
  if (dom.btnCancelPermissions) dom.btnCancelPermissions.addEventListener('click', () => {
    if (dom.permissionOverlay) dom.permissionOverlay.classList.remove('active');
    cleanupAndReturnHome();
  });

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (state.socket) state.socket.emit('leave-room');
    cleanupWebRTC();
    stopMedia();
  });
});
