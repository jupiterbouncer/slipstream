/**
 * Slipstream Application Controller
 * Handles UI screen states, user events, and Phase 1 direct peer verification.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Application State
  const state = {
    role: null, // 'host' | 'joiner'
    code: null,
    peer: null,
    qrInstance: null,
  };

  // DOM Elements
  const screens = {
    home: document.getElementById('screen-home'),
    pairing: document.getElementById('screen-pairing'),
    join: document.getElementById('screen-join'),
    connected: document.getElementById('screen-connected'),
    transfer: document.getElementById('screen-transfer'),
  };

  // Navigation & Actions
  const btnStartSend = document.getElementById('btn-start-send');
  const btnStartReceive = document.getElementById('btn-start-receive');
  const btnCancelHost = document.getElementById('btn-cancel-host');
  const btnCancelJoin = document.getElementById('btn-cancel-join');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const brandLink = document.getElementById('brand-link');

  // Host Elements
  const hostCodeText = document.getElementById('host-code-text');
  const hostStatusMsg = document.getElementById('host-status-msg');
  const qrDisplay = document.getElementById('qr-display');

  // Join Elements
  const joinForm = document.getElementById('join-form');
  const joinCodeInput = document.getElementById('join-code-input');
  const joinErrorMsg = document.getElementById('join-error-msg');
  const btnSubmitJoin = document.getElementById('btn-submit-join');

  // Connected & Test Elements
  const senderFileSection = document.getElementById('sender-file-section');
  const testChatLog = document.getElementById('test-chat-log');
  const testMessageInput = document.getElementById('test-message-input');
  const btnSendTestMsg = document.getElementById('btn-send-test-msg');
  const localDeviceLabel = document.getElementById('local-device-label');
  const peerDeviceLabel = document.getElementById('peer-device-label');

  // Modal Handlers
  const modalButtons = document.querySelectorAll('[data-modal]');
  const modalCloseButtons = document.querySelectorAll('[data-close-modal]');
  const modalOverlays = document.querySelectorAll('.modal-overlay');

  /**
   * Screen Management
   */
  function showScreen(screenName) {
    Object.values(screens).forEach((el) => {
      if (el) el.classList.remove('active');
    });
    if (screens[screenName]) {
      screens[screenName].classList.add('active');
    }
  }

  function appendChatLog(prefix, message) {
    if (!testChatLog) return;
    const line = document.createElement('div');
    line.textContent = `${prefix}: ${message}`;
    testChatLog.appendChild(line);
    testChatLog.scrollTop = testChatLog.scrollHeight;
  }

  /**
   * Reset application state and clean up resources
   */
  async function resetApp() {
    if (state.peer) {
      state.peer.close();
      state.peer = null;
    }

    if (state.code) {
      await Api.deleteSession(state.code);
      state.code = null;
    }

    state.role = null;
    if (qrDisplay) qrDisplay.innerHTML = '';
    if (joinCodeInput) joinCodeInput.value = '';
    if (joinErrorMsg) joinErrorMsg.style.display = 'none';
    if (testChatLog) testChatLog.innerHTML = 'Data channel ready.';

    showScreen('home');
  }

  /**
   * Host Flow (Send a file)
   */
  async function startHostFlow() {
    try {
      showScreen('pairing');
      hostStatusMsg.textContent = 'Generating temporary session...';
      hostCodeText.textContent = '------';

      const session = await Api.createSession();
      state.role = 'host';
      state.code = session.code;

      hostCodeText.textContent = session.code;
      hostStatusMsg.textContent = 'Waiting for peer device to connect...';

      // Generate join link for QR code
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('join', session.code);
      const joinUrl = currentUrl.toString();

      // Render high-contrast black-on-white QR code locally (§9)
      qrDisplay.innerHTML = '';
      if (window.QRCode) {
        new QRCode(qrDisplay, {
          text: joinUrl,
          width: 200,
          height: 200,
          colorDark: '#000000',
          colorLight: '#FFFFFF',
          correctLevel: QRCode.CorrectLevel.M,
        });
      }

      // Initialize WebRTC Peer Connection
      state.peer = new SlipstreamPeer({
        role: 'host',
        code: state.code,
        onStatusChange: (status) => {
          hostStatusMsg.textContent = status;
        },
        onChannelOpen: () => {
          localDeviceLabel.textContent = 'Host (Sender)';
          peerDeviceLabel.textContent = 'Receiver';
          senderFileSection.style.display = 'block';
          showScreen('connected');
          appendChatLog('System', 'Direct WebRTC data channel connected!');
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => {
          appendChatLog('System', 'Data channel closed by peer.');
        },
        onError: (err) => {
          console.error('Host connection error:', err);
          hostStatusMsg.textContent = `Error: ${err.message}`;
        },
      });

      await state.peer.start();
    } catch (err) {
      console.error('Failed to create host session:', err);
      alert(`Could not start session: ${err.message}`);
      resetApp();
    }
  }

  /**
   * Joiner Flow (Receive a file)
   */
  function startJoinFlow() {
    state.role = 'joiner';
    showScreen('join');
    joinErrorMsg.style.display = 'none';
    joinCodeInput.focus();
  }

  async function handleJoinSubmit(e) {
    if (e) e.preventDefault();
    const code = joinCodeInput.value.trim().toUpperCase();

    if (!code || code.length < 4) {
      joinErrorMsg.textContent = 'Please enter a valid pairing code.';
      joinErrorMsg.style.display = 'block';
      return;
    }

    try {
      btnSubmitJoin.disabled = true;
      btnSubmitJoin.textContent = 'Validating code...';
      joinErrorMsg.style.display = 'none';

      // Validate code with API
      const session = await Api.getSession(code);
      state.code = session.code;

      btnSubmitJoin.textContent = 'Connecting...';

      // Initialize WebRTC Peer Connection as Joiner
      state.peer = new SlipstreamPeer({
        role: 'joiner',
        code: state.code,
        onStatusChange: (status) => {
          btnSubmitJoin.textContent = status;
        },
        onChannelOpen: () => {
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'Connect to device';
          localDeviceLabel.textContent = 'Joiner (Receiver)';
          peerDeviceLabel.textContent = 'Sender';
          senderFileSection.style.display = 'none';
          showScreen('connected');
          appendChatLog('System', 'Direct WebRTC data channel connected!');
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => {
          appendChatLog('System', 'Data channel closed by peer.');
        },
        onError: (err) => {
          console.error('Joiner connection error:', err);
          btnSubmitJoin.disabled = false;
          btnSubmitJoin.textContent = 'Connect to device';
          joinErrorMsg.textContent = `Connection error: ${err.message}`;
          joinErrorMsg.style.display = 'block';
        },
      });

      await state.peer.start();
    } catch (err) {
      btnSubmitJoin.disabled = false;
      btnSubmitJoin.textContent = 'Connect to device';
      joinErrorMsg.textContent = err.message || 'Invalid or expired pairing code.';
      joinErrorMsg.style.display = 'block';
    }
  }

  /**
   * Process incoming messages over the direct WebRTC DataChannel
   */
  function handleIncomingChannelMessage(data) {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'text') {
          appendChatLog('Peer', parsed.message);
          return;
        }
      } catch {
        appendChatLog('Peer', data);
      }
    } else {
      // Binary data (Phase 2 file chunk)
      console.log('Received binary chunk:', data.byteLength, 'bytes');
    }
  }

  /**
   * Phase 1 Test Message: Send message directly across data channel
   */
  function sendTestMessage() {
    const text = testMessageInput.value.trim();
    if (!text || !state.peer) return;

    try {
      state.peer.send(JSON.stringify({ type: 'text', message: text }));
      appendChatLog('You', text);
      testMessageInput.value = '';
    } catch (err) {
      alert(`Send failed: ${err.message}`);
    }
  }

  // Event Listeners
  btnStartSend.addEventListener('click', startHostFlow);
  btnStartReceive.addEventListener('click', startJoinFlow);
  btnCancelHost.addEventListener('click', resetApp);
  btnCancelJoin.addEventListener('click', resetApp);
  btnDisconnect.addEventListener('click', resetApp);
  brandLink.addEventListener('click', (e) => {
    e.preventDefault();
    resetApp();
  });

  joinForm.addEventListener('submit', handleJoinSubmit);

  btnSendTestMsg.addEventListener('click', sendTestMessage);
  testMessageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendTestMessage();
    }
  });

  // Modal open/close handlers
  modalButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-modal');
      const targetModal = document.getElementById(modalId);
      if (targetModal) targetModal.classList.add('open');
    });
  });

  modalCloseButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      modalOverlays.forEach((m) => m.classList.remove('open'));
    });
  });

  modalOverlays.forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('open');
      }
    });
  });

  // Check URL parameters for ?join=CODE
  const urlParams = new URLSearchParams(window.location.search);
  const joinParam = urlParams.get('join');
  if (joinParam) {
    startJoinFlow();
    joinCodeInput.value = joinParam.toUpperCase();
    handleJoinSubmit();
  }
});
