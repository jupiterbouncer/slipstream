/**
 * Slipstream Application Controller
 * Handles UI screen states, user events, Phase 1 direct peer verification,
 * and subtle CSS visual state transitions (§8, §9).
 */

document.addEventListener('DOMContentLoaded', () => {
  // Application State
  const state = {
    role: null, // 'host' | 'joiner'
    code: null,
    peer: null,
    qrInstance: null,
    selectedFile: null,
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

  // Header Elements
  const headerStatus = document.getElementById('header-status');
  const headerStatusText = document.getElementById('header-status-text');

  // Host Elements
  const hostCodeText = document.getElementById('host-code-text');
  const hostStatusMsg = document.getElementById('host-status-msg');
  const qrDisplay = document.getElementById('qr-display');

  // Join Elements
  const joinForm = document.getElementById('join-form');
  const joinCodeInput = document.getElementById('join-code-input');
  const joinErrorMsg = document.getElementById('join-error-msg');
  const btnSubmitJoin = document.getElementById('btn-submit-join');
  const btnScanQr = document.getElementById('btn-scan-qr');

  // Connected & Test Elements
  const senderFileSection = document.getElementById('sender-file-section');
  const testChatLog = document.getElementById('test-chat-log');
  const testMessageInput = document.getElementById('test-message-input');
  const btnSendTestMsg = document.getElementById('btn-send-test-msg');
  const localDeviceLabel = document.getElementById('local-device-label');
  const peerDeviceLabel = document.getElementById('peer-device-label');
  const connectedDeviceItems = document.querySelectorAll('.device-item');

  // File Dropzone & Preview Elements
  const fileDropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('file-input');
  const filePreview = document.getElementById('file-preview');
  const previewFilename = document.getElementById('preview-filename');
  const previewFilesize = document.getElementById('preview-filesize');
  const btnRemoveFile = document.getElementById('btn-remove-file');
  const fileActions = document.getElementById('file-actions');
  const btnSendFile = document.getElementById('btn-send-file');
  const btnChangeFile = document.getElementById('btn-change-file');

  // Transfer Screen Elements
  const transferHeading = document.getElementById('transfer-heading');
  const transferSubtext = document.getElementById('transfer-subtext');
  const transferTrailFill = document.getElementById('transfer-trail-fill');
  const transferPercentageText = document.getElementById('transfer-percentage-text');
  const successCheckmarkBox = document.getElementById('success-checkmark-box');
  const btnCancelTransfer = document.getElementById('btn-cancel-transfer');

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

  function setHeaderConnected(isConnected) {
    if (!headerStatus) return;
    if (isConnected) {
      headerStatus.classList.add('connected');
      if (headerStatusText) headerStatusText.textContent = 'Connected';
    } else {
      headerStatus.classList.remove('connected');
      if (headerStatusText) headerStatusText.textContent = 'Local Network';
    }
  }

  function appendChatLog(prefix, message) {
    if (!testChatLog) return;
    const line = document.createElement('div');
    line.textContent = `${prefix}: ${message}`;
    testChatLog.appendChild(line);
    testChatLog.scrollTop = testChatLog.scrollHeight;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Reset application state and clean up resources
   */
  async function resetApp() {
    setHeaderConnected(false);

    if (state.peer) {
      state.peer.close();
      state.peer = null;
    }

    if (state.code) {
      await Api.deleteSession(state.code);
      state.code = null;
    }

    state.role = null;
    state.selectedFile = null;

    if (qrDisplay) {
      const scanLine = qrDisplay.querySelector('.qr-scan-line');
      qrDisplay.innerHTML = '';
      if (scanLine) qrDisplay.appendChild(scanLine);
    }

    if (joinCodeInput) joinCodeInput.value = '';
    if (joinErrorMsg) joinErrorMsg.style.display = 'none';
    if (testChatLog) testChatLog.innerHTML = 'Data channel ready.';

    // Reset file preview
    if (fileInput) fileInput.value = '';
    if (filePreview) filePreview.style.display = 'none';
    if (fileActions) fileActions.style.display = 'none';
    if (fileDropzone) fileDropzone.style.display = 'block';

    // Reset trail state
    setTrailProgress(0, 'active');
    if (successCheckmarkBox) successCheckmarkBox.style.display = 'none';

    connectedDeviceItems.forEach((el) => el.classList.remove('device-connected'));

    showScreen('home');
  }

  /**
   * Set trail progress & state (Requirements A, H, I)
   */
  function setTrailProgress(percent, status = 'active') {
    if (!transferTrailFill || !transferPercentageText) return;

    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    transferTrailFill.style.setProperty('--trail-progress', `${clamped}%`);
    transferTrailFill.style.width = `${clamped}%`;
    transferTrailFill.style.height = `${clamped}%`;
    transferPercentageText.textContent = `${clamped}%`;

    transferTrailFill.classList.remove('success', 'broken');

    if (status === 'success') {
      transferTrailFill.classList.add('success');
      if (successCheckmarkBox) successCheckmarkBox.style.display = 'flex';
      if (transferHeading) transferHeading.textContent = 'Transfer complete';
      if (transferSubtext) transferSubtext.textContent = 'Verified byte-for-byte with SHA-256 integrity.';
    } else if (status === 'broken') {
      transferTrailFill.classList.add('broken');
      if (transferHeading) transferHeading.textContent = 'Connection lost';
      if (transferSubtext) transferSubtext.textContent = 'Transfer interrupted. No incomplete file was stored.';
    }
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

      // Responsive QR dimension for narrow mobile viewports
      const qrContainerWidth = qrDisplay.clientWidth || 200;
      const qrSize = Math.max(160, Math.min(200, qrContainerWidth > 40 ? qrContainerWidth - 28 : 180));

      // Render high-contrast black-on-white QR code locally (§9)
      const scanLine = qrDisplay.querySelector('.qr-scan-line');
      qrDisplay.innerHTML = '';
      if (window.QRCode) {
        new QRCode(qrDisplay, {
          text: joinUrl,
          width: qrSize,
          height: qrSize,
          colorDark: '#000000',
          colorLight: '#FFFFFF',
          correctLevel: QRCode.CorrectLevel.M,
        });
      }
      if (scanLine) qrDisplay.appendChild(scanLine);

      // Initialize WebRTC Peer Connection
      state.peer = new SlipstreamPeer({
        role: 'host',
        code: state.code,
        onStatusChange: (status) => {
          hostStatusMsg.textContent = status;
        },
        onChannelOpen: () => {
          setHeaderConnected(true);
          localDeviceLabel.textContent = 'Host (Sender)';
          peerDeviceLabel.textContent = 'Receiver';
          senderFileSection.style.display = 'block';

          // Trigger subtle device glyph lift and settle (Requirement B)
          connectedDeviceItems.forEach((el) => {
            el.classList.add('device-connected');
          });

          showScreen('connected');
          appendChatLog('System', 'Direct WebRTC data channel connected!');
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => {
          setHeaderConnected(false);
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
      btnSubmitJoin.innerHTML = 'Connecting<span class="loading-dots"><span></span><span></span><span></span></span>';
      joinErrorMsg.style.display = 'none';

      // Validate code with API
      const session = await Api.getSession(code);
      state.code = session.code;

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
          setHeaderConnected(true);
          localDeviceLabel.textContent = 'Joiner (Receiver)';
          peerDeviceLabel.textContent = 'Sender';
          senderFileSection.style.display = 'none';

          // Trigger subtle device glyph lift and settle (Requirement B)
          connectedDeviceItems.forEach((el) => {
            el.classList.add('device-connected');
          });

          showScreen('connected');
          appendChatLog('System', 'Direct WebRTC data channel connected!');
        },
        onChannelMessage: (data) => {
          handleIncomingChannelMessage(data);
        },
        onChannelClose: () => {
          setHeaderConnected(false);
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

  /**
   * Handle File Selection and Drag & Drop (Requirement G)
   */
  function handleSelectedFile(file) {
    if (!file) return;
    state.selectedFile = file;

    if (previewFilename) previewFilename.textContent = file.name;
    if (previewFilesize) previewFilesize.textContent = formatFileSize(file.size);

    if (fileDropzone) fileDropzone.style.display = 'none';
    if (filePreview) filePreview.style.display = 'flex';
    if (fileActions) fileActions.style.display = 'flex';
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    if (fileInput) fileInput.value = '';
    if (filePreview) filePreview.style.display = 'none';
    if (fileActions) fileActions.style.display = 'none';
    if (fileDropzone) fileDropzone.style.display = 'block';
  }

  // Dropzone drag-and-drop event listeners with animated border (Requirement G)
  if (fileDropzone) {
    fileDropzone.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      fileDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileDropzone.classList.add('drag-over');
      });
    });

    ['dragleave', 'dragend'].forEach((eventName) => {
      fileDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileDropzone.classList.remove('drag-over');
      });
    });

    fileDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileDropzone.classList.remove('drag-over');

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleSelectedFile(e.dataTransfer.files[0]);
      }
    });

    fileDropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (fileInput) fileInput.click();
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleSelectedFile(e.target.files[0]);
      }
    });
  }

  if (btnRemoveFile) {
    btnRemoveFile.addEventListener('click', clearSelectedFile);
  }

  if (btnChangeFile) {
    btnChangeFile.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });
  }

  if (btnSendFile) {
    btnSendFile.addEventListener('click', () => {
      if (!state.selectedFile) {
        alert('Please choose a file to send.');
        return;
      }
      // Phase 2 file streaming hook: show transfer screen
      showScreen('transfer');
      setTrailProgress(0, 'active');
      if (transferSubtext) transferSubtext.textContent = `Ready to transfer ${state.selectedFile.name} (${formatFileSize(state.selectedFile.size)})`;
    });
  }

  if (btnCancelTransfer) {
    btnCancelTransfer.addEventListener('click', () => {
      showScreen('connected');
    });
  }

  // Navigation Event Listeners
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

  if (btnScanQr) {
    btnScanQr.addEventListener('click', () => {
      alert('Camera access requires HTTPS in browser secure contexts. On local HTTP, please enter the pairing code manually.');
      if (joinCodeInput) joinCodeInput.focus();
    });
  }

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
